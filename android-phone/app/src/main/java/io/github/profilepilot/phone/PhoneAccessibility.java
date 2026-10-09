package io.github.profilepilot.phone;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.graphics.Bitmap;
import android.graphics.Path;
import android.graphics.Rect;
import android.hardware.HardwareBuffer;
import android.os.Build;
import android.os.Bundle;
import android.util.Base64;
import android.view.Display;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.util.concurrent.CompletableFuture;

public final class PhoneAccessibility extends AccessibilityService {
    public static volatile PhoneAccessibility current;
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
    @Override public void onInterrupt() { cancelSetup(); if (ControlService.current != null) ControlService.current.localControl("pause"); }
    @Override public void onDestroy() { current = null; onInterrupt(); super.onDestroy(); }

    public CompletableFuture<Object> perform(JSONObject action) {
        CompletableFuture<Object> result = new CompletableFuture<>();
        try {
            String kind = action.getString("kind");
            if (kind.equals("find") || kind.equals("click") || kind.equals("fill") || kind.equals("scroll")) {
                boolean cacheCleared = invalidateNodeCache();
                AccessibilityNodeInfo root = freshRoot();
                if (root == null) throw new IllegalStateException("当前页面无法读取");
                try { result.complete(new PhoneSelector(action.getJSONObject("selector"), !cacheCleared).execute(root, action)); }
                finally { root.recycle(); }
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
                int code = switch (key) { case "back" -> GLOBAL_ACTION_BACK; case "home" -> GLOBAL_ACTION_HOME; case "recents" -> GLOBAL_ACTION_RECENTS; default -> throw new IllegalArgumentException("不支持此按键"); };
                if (!performGlobalAction(code)) throw new IllegalStateException("系统拒绝按键操作");
                result.complete(Boolean.TRUE);
            } else if (kind.equals("text")) {
                String value = action.getString("text"); if (value.isEmpty() || value.length() > 2000) throw new IllegalArgumentException("文本长度超出范围");
                invalidateNodeCache();
                AccessibilityNodeInfo root = freshRoot();
                AccessibilityNodeInfo field = root == null ? null : root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
                try {
                    if (field == null || !field.refresh() || !field.isEditable()) throw new IllegalStateException("请先点击可编辑的输入框");
                    Bundle args = new Bundle(); args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, value);
                    if (!field.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) throw new IllegalStateException("此输入框不支持文字输入");
                    result.complete(Boolean.TRUE);
                } finally { if (field != null) field.recycle(); if (root != null) root.recycle(); }
            } else if (kind.equals("snapshot")) {
                boolean cacheCleared = invalidateNodeCache();
                JSONArray nodes = new JSONArray(); AccessibilityNodeInfo root = freshRoot();
                if (root == null) throw new IllegalStateException("当前页面无法读取");
                int windowId = root.getWindowId();
                String packageName = safe(root.getPackageName());
                try { visit(root, nodes, 0, !cacheCleared); } finally { root.recycle(); }
                Rect screen = getSystemService(android.view.WindowManager.class).getMaximumWindowMetrics().getBounds();
                result.complete(new JSONObject().put("nodes", nodes).put("width", screen.width()).put("height", screen.height()).put("package", packageName).put("windowId", windowId));
            } else if (kind.equals("screenshot")) {
                String format = action.optString("format", "jpeg");
                if (!format.equals("jpeg") && !format.equals("png")) throw new IllegalArgumentException("不支持此截图格式");
                boolean png = format.equals("png");
                takeScreenshot(Display.DEFAULT_DISPLAY, getMainExecutor(), new TakeScreenshotCallback() {
                    @Override public void onSuccess(ScreenshotResult screenshot) {
                        HardwareBuffer buffer = screenshot.getHardwareBuffer(); Bitmap bitmap = null, scaled = null;
                        try {
                            bitmap = Bitmap.wrapHardwareBuffer(buffer, screenshot.getColorSpace());
                            if (bitmap == null) throw new IllegalStateException("无法读取屏幕画面");
                            int width = png ? bitmap.getWidth() : Math.min(1080, bitmap.getWidth()), height = Math.round((float) bitmap.getHeight() * width / bitmap.getWidth());
                            // ADB screencap consumers use pixel coordinates. Preserve the
                            // physical size and PNG bytes; never silently return a thumbnail.
                            scaled = png ? bitmap.copy(Bitmap.Config.ARGB_8888, false) : Bitmap.createScaledBitmap(bitmap, width, height, true);
                            if (scaled == null) throw new IllegalStateException("无法转换屏幕画面");
                            ByteArrayOutputStream bytes = new ByteArrayOutputStream(); scaled.compress(png ? Bitmap.CompressFormat.PNG : Bitmap.CompressFormat.JPEG, png ? 100 : 75, bytes);
                            if (bytes.size() > 5 * 1024 * 1024) throw new IllegalStateException("截图超过 5 MiB，未缩小画面，请更换页面后重新获取");
                            result.complete(new JSONObject().put("mime", png ? "image/png" : "image/jpeg").put("base64", Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP)).put("width", bitmap.getWidth()).put("height", bitmap.getHeight()));
                        } catch (Exception error) { result.completeExceptionally(error); }
                        finally { if (scaled != null && scaled != bitmap) scaled.recycle(); if (bitmap != null) bitmap.recycle(); buffer.close(); }
                    }
                    @Override public void onFailure(int code) { result.completeExceptionally(new IllegalStateException("当前画面无法截图（系统返回 " + code + "）")); }
                });
            } else throw new IllegalArgumentException("不支持此手机操作");
        } catch (Exception error) { result.completeExceptionally(error); }
        return result;
    }
    private int coordinate(JSONObject action, String key, int max) throws Exception {
        double value = action.getDouble(key); if (!Double.isFinite(value) || value != Math.floor(value) || value < 0 || value >= max) throw new IllegalArgumentException("坐标超出当前屏幕范围"); return (int) value;
    }
    private boolean invalidateNodeCache() {
        // Accessibility events keep the framework cache coherent between reads.
        // A snapshot also explicitly invalidates it: an event may still be queued
        // when an input action completes, especially for text and in-page scrolls.
        return Build.VERSION.SDK_INT >= 33 && clearCache();
    }
    private AccessibilityNodeInfo freshRoot() {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root != null && !root.refresh()) { root.recycle(); return null; }
        return root;
    }
    private void visit(AccessibilityNodeInfo node, JSONArray nodes, int depth, boolean refreshNodes) throws Exception {
        if (nodes.length() >= 400 || depth > 25) return;
        // Android 11/12 have no public cache-clear API. Refresh each visited node
        // there, before reading visibility, child IDs, bounds or text.
        if (refreshNodes && !node.refresh()) return;
        if (!node.isVisibleToUser()) return;
        nodes.put(describe(node));
        if (node.isPassword()) return;
        for (int i = 0; i < node.getChildCount() && nodes.length() < 400; i++) { AccessibilityNodeInfo child = node.getChild(i); if (child != null) { try { visit(child, nodes, depth + 1, refreshNodes); } finally { child.recycle(); } } }
    }
    static JSONObject describe(AccessibilityNodeInfo node) throws Exception {
        Rect rect = new Rect(); node.getBoundsInScreen(rect);
        return new JSONObject().put("text", node.isPassword() ? "[密码]" : safe(node.getText())).put("description", node.isPassword() ? "" : safe(node.getContentDescription())).put("class", safe(node.getClassName())).put("resourceId", safe(node.getViewIdResourceName())).put("package", safe(node.getPackageName())).put("clickable", node.isClickable()).put("editable", node.isEditable()).put("enabled", node.isEnabled()).put("checkable", node.isCheckable()).put("checked", node.isChecked()).put("selected", node.isSelected()).put("focused", node.isFocused()).put("focusable", node.isFocusable()).put("scrollable", node.isScrollable()).put("password", node.isPassword()).put("bounds", new JSONArray(new int[]{rect.left, rect.top, rect.right, rect.bottom}));
    }
    private static String safe(CharSequence value) { if (value == null) return ""; String text = value.toString(); return text.substring(0, Math.min(text.length(), 500)); }
}
