package io.github.profilepilot.phone;

import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.provider.Settings;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

final class ControlOverlay implements AutoCloseable {
    private final ControlService service;
    private final WindowManager windows;
    private LinearLayout panel, details;
    private TextView title, activity, detail;
    private Button pause;
    private WindowManager.LayoutParams params;
    private boolean expanded;
    private float startX, startY;
    private int originX, originY;
    private boolean dragging;
    private String displayedSessionId;
    ControlOverlay(ControlService service) { this.service = service; windows = service.getSystemService(WindowManager.class); }
    void update() {
        boolean show = service.session.sessionId != null && !service.session.phase.equals("stopped") && Settings.canDrawOverlays(service);
        if (!show) { close(); return; }
        if (!java.util.Objects.equals(displayedSessionId, service.session.sessionId)) close();
        if (panel == null) create();
        if (panel == null) return;
        String elapsed = "";
        if (service.session.active()) { long seconds = Math.max(0, (System.currentTimeMillis() - service.session.startedAt) / 1000); elapsed = String.format(java.util.Locale.ROOT, "  %02d:%02d", seconds / 60, seconds % 60); }
        title.setText((service.session.active() ? "● " : "Ⅱ ") + service.description() + elapsed);
        title.setTextColor(service.session.active() ? Color.rgb(116, 245, 197) : Color.rgb(255, 211, 133));
        activity.setText(service.session.activityDescription());
        detail.setText("电脑：" + service.session.computer + "\n控制者：" + service.session.controller + "\n任务：" + (service.session.task.isEmpty() ? "手机控制会话" : service.session.task));
        boolean paused = service.session.phase.equals("paused");
        pause.setText(paused ? "继续控制" : "暂停");
        pause.setEnabled(service.session.active() || paused);
        Runnable toggle = service.pauseOrResumeAction();
        pause.setOnClickListener(view -> toggle.run());
        details.setVisibility(expanded ? View.VISIBLE : View.GONE);
    }
    private void create() {
        panel = new LinearLayout(service); panel.setOrientation(LinearLayout.VERTICAL); panel.setPadding(dp(15), dp(8), dp(15), dp(8));
        GradientDrawable background = new GradientDrawable(); background.setColor(Color.rgb(12, 23, 28)); background.setCornerRadius(dp(24)); background.setStroke(dp(1), Color.rgb(68, 128, 112)); panel.setBackground(background); panel.setElevation(dp(8));
        title = new TextView(service) { @Override public boolean performClick() { expanded = !expanded; update(); return super.performClick(); } }; title.setTextSize(12); title.setTypeface(null, Typeface.BOLD); title.setMaxLines(2); title.setPadding(0, dp(3), 0, dp(3)); title.setContentDescription("ProfilePilot 控制状态，点击展开，拖动调整位置"); panel.addView(title);
        activity = new TextView(service); activity.setTextSize(11); activity.setTextColor(Color.rgb(184, 204, 197)); activity.setSingleLine(true); activity.setEllipsize(TextUtils.TruncateAt.END); activity.setPadding(0, 0, 0, dp(3)); panel.addView(activity);
        details = new LinearLayout(service); details.setOrientation(LinearLayout.VERTICAL); panel.addView(details);
        detail = new TextView(service); detail.setTextSize(12); detail.setTextColor(Color.LTGRAY); detail.setPadding(0, dp(10), 0, dp(6)); details.addView(detail);
        LinearLayout buttons = new LinearLayout(service); details.addView(buttons);
        pause = button(buttons, "暂停", () -> service.localControl("pause")); button(buttons, "结束控制", () -> service.localControl("stop"));
        button(buttons, "回到顶部", () -> { params.y = dp(8); windows.updateViewLayout(panel, params); });
        int screen = service.getResources().getDisplayMetrics().widthPixels;
        params = new WindowManager.LayoutParams(Math.min(dp(320), screen - dp(24)), WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY, WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE, PixelFormat.TRANSLUCENT);
        params.gravity = Gravity.TOP | Gravity.LEFT;
        android.content.SharedPreferences preferences = service.getSharedPreferences("overlay", 0);
        params.x = Math.max(dp(8), Math.min(screen - params.width - dp(8), preferences.getInt("x", (screen - params.width) / 2)));
        // Android's window frame already excludes the status bar/cutout. Do not
        // restore an absolute height from an earlier task (or add that inset twice).
        params.y = dp(8);
        View.OnTouchListener drag = (view, event) -> {
            if (event.getAction() == MotionEvent.ACTION_DOWN) { startX = event.getRawX(); startY = event.getRawY(); originX = params.x; originY = params.y; dragging = false; return true; }
            if (event.getAction() == MotionEvent.ACTION_MOVE) {
                float dx = event.getRawX() - startX, dy = event.getRawY() - startY;
                if (Math.abs(dx) + Math.abs(dy) > dp(8)) dragging = true;
                if (dragging) { params.x = Math.max(0, Math.min(service.getResources().getDisplayMetrics().widthPixels - params.width, originX + (int) dx)); params.y = Math.max(0, Math.min(service.getResources().getDisplayMetrics().heightPixels - panel.getHeight() - dp(40), originY + (int) dy)); windows.updateViewLayout(panel, params); } return true;
            }
            if (event.getAction() == MotionEvent.ACTION_UP) { if (!dragging) title.performClick(); else preferences.edit().putInt("x", params.x).remove("y").apply(); return true; }
            return false;
        };
        title.setOnTouchListener(drag); activity.setOnTouchListener(drag);
        try { windows.addView(panel, params); displayedSessionId = service.session.sessionId; } catch (Exception error) { panel = null; service.session.pause("顶部控制提示无法显示"); }
    }
    private Button button(LinearLayout row, String label, Runnable action) { Button button = new Button(service); button.setText(label); button.setTextSize(12); button.setAllCaps(false); button.setOnClickListener(view -> action.run()); row.addView(button, new LinearLayout.LayoutParams(0, dp(48), 1)); return button; }
    private int dp(int value) { return Math.round(value * service.getResources().getDisplayMetrics().density); }
    @Override public void close() { if (panel != null) { try { windows.removeView(panel); } catch (Exception ignored) { } panel = null; } expanded = false; displayedSessionId = null; }
}
