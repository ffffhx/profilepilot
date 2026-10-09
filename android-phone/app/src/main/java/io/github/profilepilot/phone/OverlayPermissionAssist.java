package io.github.profilepilot.phone;

import android.app.KeyguardManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import android.view.accessibility.AccessibilityNodeInfo;
import android.widget.Toast;
import java.util.ArrayList;
import java.util.List;

/** One local request, at most one app-row click and one switch click. */
final class OverlayPermissionAssist implements Runnable {
    private final PhoneAccessibility service;
    private final String settingsPackage, appLabel;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final OverlayPermissionSetup.Request request;
    private boolean cancelled, enteredSettings;

    OverlayPermissionAssist(PhoneAccessibility service, String settingsPackage) {
        this.service = service;
        this.settingsPackage = settingsPackage;
        appLabel = service.getApplicationInfo().loadLabel(service.getPackageManager()).toString();
        request = new OverlayPermissionSetup.Request(session(), SystemClock.elapsedRealtime());
    }
    void start() { handler.postDelayed(this, 250); }
    void cancel() { cancelled = true; handler.removeCallbacks(this); }
    private SessionState session() { return ControlService.current == null ? null : ControlService.current.session; }
    private boolean unlocked() { return !service.getSystemService(KeyguardManager.class).isKeyguardLocked(); }
    private void manual() {
        cancel();
        Toast.makeText(service, "请在系统设置中手动开启「" + appLabel + "」的悬浮窗权限；返回后会自动检测", Toast.LENGTH_LONG).show();
    }

    @Override public void run() {
        if (cancelled) return;
        // A checked switch or accepted click does not prove the permission was granted.
        if (Settings.canDrawOverlays(service)) {
            cancel();
            Toast.makeText(service, "悬浮窗权限已开启", Toast.LENGTH_SHORT).show();
            return;
        }
        if (!request.valid(session(), SystemClock.elapsedRealtime(), unlocked())) { manual(); return; }
        List<AccessibilityNodeInfo> handles = new ArrayList<>();
        List<DebuggingSetup.Node> nodes = new ArrayList<>();
        try {
            if (Build.VERSION.SDK_INT >= 33) service.clearCache();
            AccessibilityNodeInfo root = service.getRootInActiveWindow();
            if (root != null) {
                String foreground = String.valueOf(root.getPackageName());
                if (!settingsPackage.equals(foreground)) {
                    root.recycle();
                    if (enteredSettings || !service.getPackageName().equals(foreground)) { cancel(); return; }
                } else {
                    enteredSettings = true;
                    collect(root, -1, 0, nodes, handles);
                    if (DebuggingSetup.dialog(nodes)) { manual(); return; }
                    OverlayPermissionSetup.Target target = OverlayPermissionSetup.target(nodes, appLabel, service.getPackageName());
                    if (target.kind() == OverlayPermissionSetup.Kind.NONE) {
                        for (int i = 0; i < handles.size(); i++) {
                            AccessibilityNodeInfo node = handles.get(i);
                            String type = String.valueOf(node.getClassName());
                            if (!node.isScrollable() || !node.isEnabled()
                                || !(type.endsWith("ListView") || type.endsWith("RecyclerView"))) continue;
                            OverlayPermissionSetup.Target scroll = OverlayPermissionSetup.scrollTarget(nodes, i, appLabel, service.getPackageName());
                            if (scroll.kind() == OverlayPermissionSetup.Kind.NONE) continue;
                            if (target.kind() != OverlayPermissionSetup.Kind.NONE) { manual(); return; }
                            target = scroll;
                        }
                    }
                    if (target.kind() == OverlayPermissionSetup.Kind.SCROLL_APP_LIST) {
                        if (request.consumeScroll(OverlayPermissionSetup.pageFingerprint(nodes), session(), SystemClock.elapsedRealtime(), unlocked())
                            && !handles.get(target.index()).performAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD)) { manual(); return; }
                    } else if (target.kind() != OverlayPermissionSetup.Kind.NONE
                        && !Settings.canDrawOverlays(service)
                        && request.consume(target.kind(), session(), SystemClock.elapsedRealtime(), unlocked())) {
                        if (!handles.get(target.index()).performAction(AccessibilityNodeInfo.ACTION_CLICK)) { manual(); return; }
                    }
                }
            }
        } catch (IllegalStateException | SecurityException unavailable) {
            manual();
        } finally {
            for (AccessibilityNodeInfo handle : handles) handle.recycle();
        }
        if (!cancelled) handler.postDelayed(this, 250);
    }

    private void collect(AccessibilityNodeInfo node, int parent, int depth,
                         List<DebuggingSetup.Node> nodes, List<AccessibilityNodeInfo> handles) {
        handles.add(node);
        if (handles.size() > 400 || depth > 25 || !node.refresh()) throw new IllegalStateException("Incomplete tree");
        if (!node.isVisibleToUser()) { handles.remove(handles.size() - 1); node.recycle(); return; }
        if (!settingsPackage.contentEquals(node.getPackageName() == null ? "" : node.getPackageName())) throw new IllegalStateException("Unexpected package");
        int index = nodes.size();
        String className = String.valueOf(node.getClassName());
        nodes.add(new DebuggingSetup.Node(parent, String.valueOf(node.getText()), String.valueOf(node.getViewIdResourceName()),
            node.isCheckable() && (className.endsWith("Switch") || className.endsWith("SwitchCompat")),
            node.isChecked(), node.isEnabled(), node.isClickable()));
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child == null) throw new IllegalStateException("Missing child");
            collect(child, index, depth + 1, nodes, handles);
        }
    }
}
