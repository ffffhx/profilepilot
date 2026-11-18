package io.github.profilepilot.phone;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Path;
import android.graphics.Rect;
import android.hardware.HardwareBuffer;
import android.os.Build;
import android.os.Bundle;
import android.os.PersistableBundle;
import android.util.Base64;
import android.view.Display;
import android.view.View;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;

public final class PhoneAccessibility extends AccessibilityService {
    public static volatile PhoneAccessibility current;
    static final int MAX_SNAPSHOT_NODES = 800;
    private final ScreenshotWorker screenshots = new ScreenshotWorker();
    private final Set<CompletableFuture<Object>> pendingScreenshots = ConcurrentHashMap.newKeySet();
    private FollowTouch followTouch;

    void followTouch(JSONObject input, java.util.function.BooleanSupplier authorized) throws Exception {
        if (followTouch == null) followTouch = new FollowTouch(this);
        followTouch.update(input.getJSONArray("points"), input.optInt("ttlMs", 1200), authorized, input.getLong("sequence"));
    }
    void releaseFollowTouch() { if (followTouch != null) followTouch.release(); }
    void resetFollowTouch() {
        if (followTouch != null && followTouch.active()) throw new IllegalStateException("正在释放上一任务的触点，请稍候");
        followTouch = null;
    }

    private DebuggingAssist debuggingSetup;
    private OverlayPermissionAssist overlaySetup;
    void prepareDebugging(String settingsPackage, DebuggingSetup.Setting setting) {
        cancelSetup();
        debuggingSetup = new DebuggingAssist(this, settingsPackage, setting);
        debuggingSetup.start();
    }
    void cancelDebugging() {
        if (debuggingSetup != null) debuggingSetup.cancel();
        debuggingSetup = null;
    }
    void prepareOverlayPermission(String settingsPackage) {
        cancelSetup();
        overlaySetup = new OverlayPermissionAssist(this, settingsPackage);
        overlaySetup.start();
    }
    void cancelSetup() {
        cancelDebugging();
        if (overlaySetup != null) overlaySetup.cancel();
        overlaySetup = null;
    }

    @Override protected void onServiceConnected() { current = this; }
    @Override public void onAccessibilityEvent(AccessibilityEvent event) { }
    @Override public void onInterrupt() {
        cancelSetup(); releaseFollowTouch();
        if (ControlService.current != null) ControlService.current.localControl("pause");
        for (CompletableFuture<Object> pending : pendingScreenshots)
            pending.completeExceptionally(new IllegalStateException("无障碍服务已中断，截图已停止"));
    }
    @Override public void onDestroy() { current = null; onInterrupt(); screenshots.close(); super.onDestroy(); }

    public CompletableFuture<Object> perform(JSONObject action) {
        return perform(action, null);
    }
    CompletableFuture<Object> perform(JSONObject action, ControlTiming timing) {
        return perform(action, timing, null);
    }
    CompletableFuture<Object> perform(JSONObject action, ControlTiming timing, ScreenshotRegion region) {
        CompletableFuture<Object> result = new CompletableFuture<>();
        try {
            String kind = action.getString("kind");
            if (kind.equals("find") || kind.equals("click") || kind.equals("fill") || kind.equals("scroll")) {
                boolean cacheCleared = invalidateNodeCache();
                List<AccessibilityNodeInfo> roots = freshRoots();
                if (roots.isEmpty()) throw new IllegalStateException("当前页面无法读取");
                try { result.complete(new PhoneSelector(this, action.getJSONObject("selector"), !cacheCleared).execute(roots, action)); }
                finally { recycleAll(roots); }
            } else if (kind.equals("tap") || kind.equals("swipe")) {
                Rect screen = getSystemService(android.view.WindowManager.class).getMaximumWindowMetrics().getBounds();
                int width = screen.width(), height = screen.height();
                int x = coordinate(action, "x", width), y = coordinate(action, "y", height);
                Path path = new Path(); path.moveTo(x, y);
                long duration = kind.equals("tap") ? 60 : action.optInt("duration", 350);
                if (duration < 50 || duration > 2000) throw new IllegalArgumentException("手势时长超出范围");
                if (kind.equals("swipe")) path.lineTo(coordinate(action, "toX", width), coordinate(action, "toY", height));
                GestureDescription gesture = new GestureDescription.Builder().addStroke(new GestureDescription.StrokeDescription(path, 0, duration)).build();
                boolean accepted = dispatchGesture(gesture, new GestureResultCallback() {
                    @Override public void onCompleted(GestureDescription gesture) { result.complete(Boolean.TRUE); }
                    @Override public void onCancelled(GestureDescription gesture) { result.completeExceptionally(new IllegalStateException("手势已取消，请观察页面后再操作")); }
                }, null);
                if (!accepted) throw new IllegalStateException("系统未接受手势");
            } else if (kind.equals("key")) {
                String key = action.getString("key");
                performKey(key);
                result.complete(Boolean.TRUE);
            } else if (kind.equals("text")) {
                String value = action.getString("text"); if (value.isEmpty() || value.length() > 2000) throw new IllegalArgumentException("文本长度超出范围");
                invalidateNodeCache();
                List<AccessibilityNodeInfo> roots = freshRoots();
                AccessibilityNodeInfo field = findInputFocus(roots);
                try {
                    if (field == null || !field.refresh() || !field.isEditable()) throw new IllegalStateException("请先点击可编辑的输入框");
                    if (!replaceNodeText(this, field, value)) throw new IllegalStateException("此输入框不支持文字输入");
                    result.complete(Boolean.TRUE);
                } finally { if (field != null) field.recycle(); recycleAll(roots); }
            } else if (kind.equals("snapshot")) {
                boolean cacheCleared = invalidateNodeCache();
                List<AccessibilityNodeInfo> roots = freshRoots();
                if (roots.isEmpty()) throw new IllegalStateException("当前页面无法读取");
                AccessibilityNodeInfo primary = primaryRoot(roots);
                int windowId = primary.getWindowId();
                String packageName = safe(primary.getPackageName());
                JSONArray nodes = new JSONArray();
                JSONArray elements = new JSONArray();
                StringBuilder summary = new StringBuilder();
                int[] counters = new int[]{0, 0}; // [visitedRaw, assignedRefs]
                try {
                    for (AccessibilityNodeInfo root : roots) {
                        visitSnapshot(root, nodes, elements, summary, 0, !cacheCleared, counters);
                    }
                    if (nodes.length() == 0) {
                        JSONObject fallback = describe(primary).put("ref", "@e1");
                        nodes.put(fallback);
                    }
                } finally { recycleAll(roots); }
                Rect screen = getSystemService(android.view.WindowManager.class).getMaximumWindowMetrics().getBounds();
                result.complete(new JSONObject()
                    .put("nodes", nodes)
                    .put("elements", elements)
                    .put("summary", summary.toString().trim())
                    .put("width", screen.width())
                    .put("height", screen.height())
                    .put("package", packageName)
                    .put("windowId", windowId));
            } else if (kind.equals("screenshot")) {
                String format = action.optString("format", "jpeg");
                if (!format.equals("jpeg") && !format.equals("png")) throw new IllegalArgumentException("不支持此截图格式");
                boolean png = format.equals("png");
                boolean nativeSize = png || action.optBoolean("nativeSize", false);
                // Only explicitly negotiated full follow frames carry provenance.
                FollowTouch cameraOwner = action.optInt("cameraFrameProvenance", 0) == 1 && nativeSize && region == null ? followTouch : null;
                FollowCameraProof.Snapshot cameraBefore = cameraOwner == null ? null : cameraOwner.cameraSnapshot();
                pendingScreenshots.add(result);
                result.whenComplete((value, error) -> pendingScreenshots.remove(result));
                if (timing != null) timing.mark("captureRequested");
                takeScreenshot(Display.DEFAULT_DISPLAY, getMainExecutor(), new TakeScreenshotCallback() {
                    @Override public void onSuccess(ScreenshotResult screenshot) {
                        if (timing != null) timing.mark("captureReady");
                        HardwareBuffer buffer = screenshot.getHardwareBuffer();
                        try {
                            JSONObject cameraProof = cameraOwner == null || cameraOwner != followTouch ? null
                                : cameraOwner.cameraCaptured(cameraBefore, screenshot.getTimestamp());
                            if (timing != null) timing.mark("encodeQueued");
                            screenshots.submit(buffer, () -> encodeScreenshot(screenshot, png, nativeSize, timing, region, cameraProof), result);
                        } catch (Exception error) { buffer.close(); result.completeExceptionally(error); }
                    }
                    @Override public void onFailure(int code) { result.completeExceptionally(new IllegalStateException("当前画面无法截图（系统返回 " + code + "）")); }
                });
            } else throw new IllegalArgumentException("不支持此手机操作");
        } catch (Exception error) { result.completeExceptionally(error); }
        return result;
    }

    private void performKey(String key) {
        switch (key) {
            case "back", "escape" -> {
                if (!performGlobalAction(GLOBAL_ACTION_BACK)) throw new IllegalStateException("系统拒绝按键操作");
            }
            case "home" -> {
                if (!performGlobalAction(GLOBAL_ACTION_HOME)) throw new IllegalStateException("系统拒绝按键操作");
            }
            case "recents" -> {
                if (!performGlobalAction(GLOBAL_ACTION_RECENTS)) throw new IllegalStateException("系统拒绝按键操作");
            }
            case "enter", "search" -> {
                invalidateNodeCache();
                List<AccessibilityNodeInfo> roots = freshRoots();
                AccessibilityNodeInfo field = findInputFocus(roots);
                try {
                    boolean done = false;
                    if (field != null && field.refresh()) {
                        done = field.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.getId());
                        if (!done && key.equals("enter") && field.isClickable()) {
                            done = field.performAction(AccessibilityNodeInfo.ACTION_CLICK);
                        }
                        if (!done && key.equals("enter") && field.isEditable() && !field.isPassword()) {
                            String existing = field.getText() == null ? "" : field.getText().toString();
                            done = replaceNodeText(this, field, existing + "\n");
                        }
                    }
                    if (!done) throw new IllegalStateException("当前焦点控件不支持提交/搜索按键");
                } finally {
                    if (field != null) field.recycle();
                    recycleAll(roots);
                }
            }
            case "backspace", "delete" -> {
                invalidateNodeCache();
                List<AccessibilityNodeInfo> roots = freshRoots();
                AccessibilityNodeInfo field = findInputFocus(roots);
                try {
                    if (field == null || !field.refresh() || !field.isEditable()) throw new IllegalStateException("请先点击可编辑的输入框");
                    String currentText = field.isPassword() || field.getText() == null ? "" : field.getText().toString();
                    int selStart = field.getTextSelectionStart();
                    int selEnd = field.getTextSelectionEnd();
                    String nextText;
                    int nextCursor;
                    if (selStart >= 0 && selEnd >= 0 && selStart <= currentText.length() && selEnd <= currentText.length()) {
                        int start = Math.min(selStart, selEnd), end = Math.max(selStart, selEnd);
                        if (start != end) {
                            nextText = currentText.substring(0, start) + currentText.substring(end);
                            nextCursor = start;
                        } else if (key.equals("backspace") && start > 0) {
                            int prev = Character.offsetByCodePoints(currentText, start, -1);
                            nextText = currentText.substring(0, prev) + currentText.substring(start);
                            nextCursor = prev;
                        } else if (key.equals("delete") && start < currentText.length()) {
                            int after = Character.offsetByCodePoints(currentText, start, 1);
                            nextText = currentText.substring(0, start) + currentText.substring(after);
                            nextCursor = start;
                        } else {
                            return;
                        }
                    } else if (key.equals("backspace") && !currentText.isEmpty()) {
                        int prev = Character.offsetByCodePoints(currentText, currentText.length(), -1);
                        nextText = currentText.substring(0, prev);
                        nextCursor = prev;
                    } else {
                        return;
                    }
                    if (!replaceNodeText(this, field, nextText)) throw new IllegalStateException("此输入框不支持删除字符");
                    Bundle selection = new Bundle();
                    selection.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, nextCursor);
                    selection.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, nextCursor);
                    field.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, selection);
                } finally {
                    if (field != null) field.recycle();
                    recycleAll(roots);
                }
            }
            case "tab" -> {
                invalidateNodeCache();
                List<AccessibilityNodeInfo> roots = freshRoots();
                AccessibilityNodeInfo focused = findInputFocus(roots);
                AccessibilityNodeInfo next = null;
                try {
                    if (focused != null) next = focused.focusSearch(View.FOCUS_FORWARD);
                    if (next == null || !next.performAction(AccessibilityNodeInfo.ACTION_FOCUS)) {
                        throw new IllegalStateException("未找到下一个可聚焦控件");
                    }
                } finally {
                    if (next != null) next.recycle();
                    if (focused != null) focused.recycle();
                    recycleAll(roots);
                }
            }
            default -> throw new IllegalArgumentException("不支持此按键");
        }
    }

    static boolean replaceNodeText(Context context, AccessibilityNodeInfo node, String value) {
        Bundle args = new Bundle();
        args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, value);
        if (node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) return true;
        if (context == null) return false;
        ClipboardManager clipboard = context.getSystemService(ClipboardManager.class);
        if (clipboard == null) return false;
        if (!node.isFocused()) {
            node.performAction(AccessibilityNodeInfo.ACTION_FOCUS);
            if (!node.isFocused() && node.isClickable()) node.performAction(AccessibilityNodeInfo.ACTION_CLICK);
        }
        CharSequence existing = node.isPassword() ? null : node.getText();
        if (existing != null && existing.length() > 0) {
            Bundle sel = new Bundle();
            sel.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, 0);
            sel.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, existing.length());
            node.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, sel);
            if (value.isEmpty()) {
                return node.performAction(AccessibilityNodeInfo.ACTION_CUT);
            }
        } else if (value.isEmpty()) {
            return true;
        }
        ClipData clip = ClipData.newPlainText("ProfilePilot", value);
        if (clip.getDescription() != null) {
            PersistableBundle extras = new PersistableBundle();
            extras.putBoolean("android.content.extra.IS_SENSITIVE", true);
            clip.getDescription().setExtras(extras);
        }
        try {
            clipboard.setPrimaryClip(clip);
            return node.performAction(AccessibilityNodeInfo.ACTION_PASTE);
        } finally {
            try { clipboard.clearPrimaryClip(); } catch (RuntimeException ignored) { }
        }
    }

    private JSONObject encodeScreenshot(ScreenshotResult screenshot, boolean png, boolean nativeSize, ControlTiming timing, ScreenshotRegion region, JSONObject cameraProof) throws Exception {
        if (timing != null) timing.mark("encodeStarted");
        Bitmap bitmap = null, scaled = null, cropped = null;
        try {
            bitmap = Bitmap.wrapHardwareBuffer(screenshot.getHardwareBuffer(), screenshot.getColorSpace());
            if (bitmap == null) throw new IllegalStateException("无法读取屏幕画面");
            if (region != null) {
                if (!nativeSize) throw new IllegalArgumentException("截图区域需要原始像素尺寸");
                region.requireWithin(bitmap.getWidth(), bitmap.getHeight());
            }
            int width = nativeSize ? bitmap.getWidth() : Math.min(1080, bitmap.getWidth()), height = Math.round((float) bitmap.getHeight() * width / bitmap.getWidth());
            // Preserve physical pixels for ADB and native follow frames. Only
            // ordinary JPEG previews use the existing 1080px thumbnail behavior.
            scaled = nativeSize ? bitmap.copy(Bitmap.Config.ARGB_8888, false) : Bitmap.createScaledBitmap(bitmap, width, height, true);
            if (scaled == null) throw new IllegalStateException("无法转换屏幕画面");
            cropped = region == null ? scaled : Bitmap.createBitmap(scaled, region.x(), region.y(), region.width(), region.height());
            if (timing != null) timing.mark("bitmapCopied");
            ByteArrayOutputStream bytes = new ByteArrayOutputStream(); cropped.compress(png ? Bitmap.CompressFormat.PNG : Bitmap.CompressFormat.JPEG, png ? 100 : 75, bytes);
            if (timing != null) timing.mark("compressed");
            if (bytes.size() > 5 * 1024 * 1024) throw new IllegalStateException("截图超过 5 MiB，未缩小画面，请更换页面后重新获取");
            JSONObject encoded = new JSONObject().put("mime", png ? "image/png" : "image/jpeg").put("base64", Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP)).put("width", bitmap.getWidth()).put("height", bitmap.getHeight());
            if (region != null) encoded.put("region", region.toJson());
            if (cameraProof != null) encoded.put("cameraProof", cameraProof);
            if (timing != null) timing.mark("base64");
            return encoded;
        } finally {
            if (cropped != null && cropped != scaled && cropped != bitmap) cropped.recycle();
            if (scaled != null && scaled != bitmap) scaled.recycle();
            if (bitmap != null) bitmap.recycle();
        }
    }

    private int coordinate(JSONObject action, String key, int max) throws Exception {
        double value = action.getDouble(key); if (!Double.isFinite(value) || value != Math.floor(value) || value < 0 || value >= max) throw new IllegalArgumentException("坐标超出当前屏幕范围"); return (int) value;
    }

    private boolean invalidateNodeCache() {
        return Build.VERSION.SDK_INT >= 33 && clearCache();
    }

    private AccessibilityNodeInfo findInputFocus(List<AccessibilityNodeInfo> roots) {
        for (AccessibilityNodeInfo root : roots) {
            AccessibilityNodeInfo focus = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
            if (focus != null) return focus;
        }
        for (AccessibilityNodeInfo root : roots) {
            AccessibilityNodeInfo focus = root.findFocus(AccessibilityNodeInfo.FOCUS_ACCESSIBILITY);
            if (focus != null) return focus;
        }
        return null;
    }

    private AccessibilityNodeInfo primaryRoot(List<AccessibilityNodeInfo> roots) {
        return roots.get(roots.size() - 1);
    }

    /** Collect interactive overlay/dialog windows above the active window plus the active window itself. */
    private List<AccessibilityNodeInfo> freshRoots() {
        List<AccessibilityNodeInfo> results = new ArrayList<>();
        Set<Integer> seenWindowIds = new HashSet<>();
        AccessibilityNodeInfo active = getRootInActiveWindow();
        if (active != null && !active.refresh()) { active.recycle(); active = null; }
        int activeWindowId = active == null ? -1 : active.getWindowId();
        int activeLayer = -1;
        List<AccessibilityWindowInfo> windows = null;
        try { windows = getWindows(); } catch (RuntimeException ignored) { }
        if (windows != null && !windows.isEmpty()) {
            windows.sort((a, b) -> Integer.compare(b.getLayer(), a.getLayer()));
            for (AccessibilityWindowInfo w : windows) {
                if (w.getId() == activeWindowId) {
                    activeLayer = w.getLayer();
                    break;
                }
            }
            if (active == null) {
                for (AccessibilityWindowInfo w : windows) {
                    if (w.isFocused() || w.isActive() || w.getType() == AccessibilityWindowInfo.TYPE_APPLICATION) {
                        AccessibilityNodeInfo candidate = w.getRoot();
                        if (candidate != null) {
                            if (candidate.refresh()) {
                                active = candidate;
                                activeWindowId = w.getId();
                                activeLayer = w.getLayer();
                                break;
                            }
                            candidate.recycle();
                        }
                    }
                }
            }
            String ownPackage = getPackageName();
            for (AccessibilityWindowInfo w : windows) {
                if (w.getId() == activeWindowId || seenWindowIds.contains(w.getId())) continue;
                boolean aboveActive = activeLayer >= 0 && w.getLayer() > activeLayer;
                boolean interactiveOverlay = (aboveActive && w.getType() == AccessibilityWindowInfo.TYPE_APPLICATION)
                    || (w.isFocused() && (w.getType() == AccessibilityWindowInfo.TYPE_APPLICATION
                        || w.getType() == AccessibilityWindowInfo.TYPE_SYSTEM));
                if (!interactiveOverlay) continue;
                AccessibilityNodeInfo wRoot = w.getRoot();
                if (wRoot == null) continue;
                if (!wRoot.refresh()) { wRoot.recycle(); continue; }
                String pkg = safe(wRoot.getPackageName());
                if (ownPackage.equals(pkg) && !w.isFocused()) {
                    // Never expose ProfilePilot's own ControlOverlay capsule window.
                    wRoot.recycle();
                    continue;
                }
                seenWindowIds.add(w.getId());
                results.add(wRoot);
            }
        }
        if (active != null && seenWindowIds.add(activeWindowId)) {
            results.add(active);
        } else if (active != null) {
            active.recycle();
        }
        return results;
    }

    private static void recycleAll(List<AccessibilityNodeInfo> roots) {
        for (AccessibilityNodeInfo root : roots) {
            if (root != null) root.recycle();
        }
        roots.clear();
    }

    static boolean isMeaningfulNode(AccessibilityNodeInfo node) {
        if (node.isClickable() || node.isEditable() || node.isScrollable()
                || node.isCheckable() || node.isChecked() || node.isSelected()
                || node.isFocused() || node.isPassword()) {
            return true;
        }
        return hasContent(node.getText())
                || hasContent(node.getContentDescription())
                || hasContent(node.getViewIdResourceName());
    }

    private static boolean hasContent(CharSequence value) {
        return value != null && value.length() > 0;
    }

    private void visitSnapshot(AccessibilityNodeInfo node, JSONArray nodes, JSONArray elements,
            StringBuilder summary, int depth, boolean refreshNodes, int[] counters) throws Exception {
        if (nodes.length() >= MAX_SNAPSHOT_NODES || counters[0] >= PhoneSelector.MAX_NODES || depth > PhoneSelector.MAX_DEPTH) return;
        counters[0]++;
        if (refreshNodes && !node.refresh()) return;
        if (!node.isVisibleToUser()) return;
        if (isMeaningfulNode(node)) {
            String ref = "@e" + (++counters[1]);
            JSONObject item = describe(node).put("ref", ref);
            nodes.put(item);
            JSONObject compact = compactElement(item, ref);
            elements.put(compact);
            if (summary.length() < 16000) {
                if (summary.length() > 0) summary.append('\n');
                summary.append(formatSummaryLine(item, ref));
            }
        }
        if (node.isPassword()) return;
        for (int i = 0; i < node.getChildCount() && nodes.length() < MAX_SNAPSHOT_NODES && counters[0] < PhoneSelector.MAX_NODES; i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child != null) {
                try { visitSnapshot(child, nodes, elements, summary, depth + 1, refreshNodes, counters); }
                finally { child.recycle(); }
            }
        }
    }

    private static JSONObject compactElement(JSONObject item, String ref) throws Exception {
        JSONObject out = new JSONObject().put("ref", ref);
        String cls = item.optString("class", "");
        int dot = cls.lastIndexOf('.');
        out.put("role", dot >= 0 ? cls.substring(dot + 1) : cls);
        for (String key : new String[]{"text", "description", "resourceId"}) {
            String val = item.optString(key, "");
            if (!val.isEmpty()) out.put(key, val);
        }
        for (String flag : new String[]{"clickable", "editable", "scrollable", "checked"}) {
            if (item.optBoolean(flag, false)) out.put(flag, true);
        }
        if (!item.optBoolean("enabled", true)) out.put("enabled", false);
        out.put("bounds", item.getJSONArray("bounds"));
        return out;
    }

    private static String formatSummaryLine(JSONObject item, String ref) {
        String cls = item.optString("class", "");
        int dot = cls.lastIndexOf('.');
        String role = dot >= 0 ? cls.substring(dot + 1) : cls;
        StringBuilder line = new StringBuilder(ref).append(" [").append(role.isEmpty() ? "View" : role).append(']');
        String text = item.optString("text", "");
        String desc = item.optString("description", "");
        String id = item.optString("resourceId", "");
        if (!text.isEmpty()) line.append(" \"").append(text.replace('\n', ' ')).append('"');
        if (!desc.isEmpty() && !desc.equals(text)) line.append(" (desc=\"").append(desc.replace('\n', ' ')).append("\")");
        if (!id.isEmpty()) line.append(" #").append(id.substring(id.indexOf('/') + 1));
        return line.toString();
    }

    static JSONObject describe(AccessibilityNodeInfo node) throws Exception {
        Rect rect = new Rect(); node.getBoundsInScreen(rect);
        return new JSONObject()
            .put("text", node.isPassword() ? "[密码]" : safe(node.getText()))
            .put("description", node.isPassword() ? "" : safe(node.getContentDescription()))
            .put("class", safe(node.getClassName()))
            .put("resourceId", safe(node.getViewIdResourceName()))
            .put("package", safe(node.getPackageName()))
            .put("clickable", node.isClickable())
            .put("editable", node.isEditable())
            .put("enabled", node.isEnabled())
            .put("checkable", node.isCheckable())
            .put("checked", node.isChecked())
            .put("selected", node.isSelected())
            .put("focused", node.isFocused())
            .put("focusable", node.isFocusable())
            .put("scrollable", node.isScrollable())
            .put("password", node.isPassword())
            .put("bounds", new JSONArray(new int[]{rect.left, rect.top, rect.right, rect.bottom}));
    }

    private static String safe(CharSequence value) { if (value == null) return ""; String text = value.toString(); return text.substring(0, Math.min(text.length(), 500)); }
}
