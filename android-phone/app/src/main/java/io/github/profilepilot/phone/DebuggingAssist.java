package io.github.profilepilot.phone;

import android.app.KeyguardManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.accessibility.AccessibilityNodeInfo;
import android.widget.Toast;
import java.util.ArrayList;
import java.util.List;

/** Bounded local setup: open one switch; never approve a system dialog. */
final class DebuggingAssist implements Runnable {
    private final PhoneAccessibility service;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final DebuggingSetup.Request request;
    private final DebuggingSetup.Setting setting;
    private final String settingsPackage;
    private boolean cancelled, enteredSettings;

    DebuggingAssist(PhoneAccessibility service, String settingsPackage, DebuggingSetup.Setting setting) {
        this.service = service;
        this.settingsPackage = settingsPackage;
        this.setting = setting;
        request = new DebuggingSetup.Request(session(), SystemClock.elapsedRealtime());
    }
    void start() { handler.postDelayed(this, 250); }
    void cancel() { cancelled = true; handler.removeCallbacks(this); }
    private SessionState session() { return ControlService.current == null ? null : ControlService.current.session; }
    private boolean unlocked() { return !service.getSystemService(KeyguardManager.class).isKeyguardLocked(); }

    @Override public void run() {
        if (cancelled) return;
        if (!request.valid(session(), SystemClock.elapsedRealtime(), unlocked())) { cancel(); return; }
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
                    if (DebuggingSetup.dialog(nodes)) { cancel(); return; }
                    int target = DebuggingSetup.target(nodes, setting);
                    if (target == DebuggingSetup.ALREADY_ENABLED) { cancel(); return; }
                    if (target >= 0) {
                        // Consume before dispatch. Polling can only read, never repeat input.
                        boolean allowed = request.consume(session(), SystemClock.elapsedRealtime(), unlocked());
                        cancel();
                        if (allowed) {
                            boolean accepted = handles.get(target).performAction(AccessibilityNodeInfo.ACTION_CLICK);
                            Toast.makeText(service, accepted ? "如出现系统授权提示，请确认是否允许" + setting.label : "已定位" + setting.label + "，请手动打开开关", Toast.LENGTH_LONG).show();
                        }
                        return;
                    }
                }
            }
        } catch (IllegalStateException | SecurityException unavailable) {
            cancel();
            Toast.makeText(service, "请在当前页面手动打开" + setting.label, Toast.LENGTH_LONG).show();
        } finally {
            for (AccessibilityNodeInfo handle : handles) handle.recycle();
        }
        if (!cancelled) handler.postDelayed(this, 250);
    }

    private void collect(AccessibilityNodeInfo node, int parent, int depth,
                         List<DebuggingSetup.Node> nodes, List<AccessibilityNodeInfo> handles) {
        // Reject partial or stale trees instead of inferring a unique switch from them.
        handles.add(node);
        if (handles.size() > 400 || depth > 25 || !node.refresh()) throw new IllegalStateException("Incomplete tree");
        if (!node.isVisibleToUser()) { handles.remove(handles.size() - 1); node.recycle(); return; }
        if (!settingsPackage.contentEquals(node.getPackageName() == null ? "" : node.getPackageName())) throw new IllegalStateException("Unexpected package");
        int index = nodes.size();
        nodes.add(new DebuggingSetup.Node(parent, String.valueOf(node.getText()), String.valueOf(node.getViewIdResourceName()),
            node.isCheckable() && String.valueOf(node.getClassName()).endsWith("Switch"), node.isChecked(), node.isEnabled(), node.isClickable()));
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child == null) throw new IllegalStateException("Missing child");
            collect(child, index, depth + 1, nodes, handles);
        }
    }
}
