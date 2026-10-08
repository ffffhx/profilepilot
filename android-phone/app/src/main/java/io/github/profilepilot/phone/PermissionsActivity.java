package io.github.profilepilot.phone;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationManager;
import android.content.Intent;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

public final class PermissionsActivity extends Activity {
  // Match the mobile workbench's palette, spacing and surface shapes.
  private static final int BLUE = 0xff3976ed, INK = 0xff233047, MUTED = 0xff718097,
      BG = 0xfff6f8fc, LINE = 0xffe5ebf4, SOFT_BLUE = 0xffedf3ff,
      GREEN = 0xff19755e, RED = 0xffaa3446;
  private final Handler handler = new Handler();
  private TextView status, serviceButton, serviceError, permissionCount, sessionDetails, pauseButton;
  private TextView readinessSummary, connectionState, developerState, usbState, wirelessState, unlockState;
  private LinearLayout sessionCard;
  private final TextView[] permissionStates = new TextView[3];
  private final View[] permissionRows = new View[3];
  private static final String[] PERMISSION_NAMES = {"悬浮窗 · 顶部胶囊", "控制状态通知", "无障碍服务"};
  private String pendingToken, pendingComputer;
  private final Runnable refresh =
      new Runnable() {
        public void run() {
          update();
          handler.postDelayed(this, 1000);
        }
      };

  @Override
  public void onCreate(Bundle state) {
    super.onCreate(state);
    getWindow().setStatusBarColor(BG);
    getWindow().setNavigationBarColor(BG);
    getWindow().getDecorView().setSystemUiVisibility(
        View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
    if (state != null) {
      pendingToken = state.getString("pendingToken");
      pendingComputer = state.getString("pendingComputer");
    }
    readIntent();
    render();
    reconnectTrustedComputer();
  }

  @Override
  protected void onSaveInstanceState(Bundle state) {
    state.putString("pendingToken", pendingToken);
    state.putString("pendingComputer", pendingComputer);
    super.onSaveInstanceState(state);
  }

  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    setIntent(intent);
    readIntent();
    render();
    reconnectTrustedComputer();
  }

  private void reconnectTrustedComputer() {
    // Only an explicit connection request from the already paired computer
    // restarts the service after an APK update. It never starts control.
    if (pendingToken != null
        && pendingToken.equals(
            getSharedPreferences("MainActivity", MODE_PRIVATE).getString("token", ""))
        && pendingComputer != null
        && pendingComputer.equals(
            getSharedPreferences("MainActivity", MODE_PRIVATE).getString("computer", ""))) {
      pendingToken = null;
      // A known computer reconnects to the home status page; new pairings still
      // stay here for the user's explicit approval.
      if (startServiceNow()) finish();
    }
  }

  private void readIntent() {
    String token = getIntent().getStringExtra("token"),
        host = getIntent().getStringExtra("computer");
    if (token != null && token.matches("[a-f0-9]{64}") && host != null && host.length() <= 120) {
      pendingToken = token;
      pendingComputer = host;
    }
    // Remove credentials from our Activity's retained intent after parsing.
    getIntent().removeExtra("token");
  }

  private void render() {
    LinearLayout root = column();
    root.setBackgroundColor(BG);
    root.setOnApplyWindowInsetsListener((view, insets) -> {
      android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars());
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
      return insets;
    });
    LinearLayout toolbar = row();
    toolbar.setPadding(dp(10), dp(16), dp(22), dp(12));
    root.addView(toolbar);
    TextView back = new TextView(this);
    back.setText("‹");
    back.setTextSize(32);
    back.setTextColor(BLUE);
    back.setGravity(Gravity.CENTER);
    back.setContentDescription("返回工作区");
    back.setBackground(ripple(BG, 10, false));
    back.setFocusable(true);
    back.setOnClickListener(view -> finish());
    toolbar.addView(back, new LinearLayout.LayoutParams(dp(48), dp(48)));
    text(toolbar, "ProfilePilot", 20, INK);
    ScrollView scroll = new ScrollView(this);
    scroll.setFillViewport(true);
    scroll.setClipToPadding(false);
    LinearLayout page = column();
    page.setPadding(dp(22), dp(8), dp(22), dp(28));
    scroll.addView(page);
    root.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
    setContentView(root);
    text(page, "授权与控制", 29, INK);
    text(page, "查看连接、管理权限，手机控制由你掌握。", 14, MUTED);

    LinearLayout connection = card(page);
    connection.setBackground(background(SOFT_BLUE, 16, false));
    text(connection, "电脑连接", 13, MUTED);
    String trusted = getSharedPreferences("MainActivity", MODE_PRIVATE).getString("token", "");
    boolean pairing = pendingToken != null && !pendingToken.equals(trusted);
    text(connection, pairing ? pendingComputer : trusted.isEmpty() ? "尚未配对电脑"
        : getSharedPreferences("MainActivity", MODE_PRIVATE).getString("computer", "电脑"), 22, INK);
    status = text(connection, "正在检查连接…", 14, BLUE);
    status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
    serviceButton = null;
    if (pairing) {
      button(
          connection,
          "允许此电脑连接",
          true,
          view -> {
            if (ControlService.current != null) {
              ControlService.current.localControl("stop");
              stopService(new Intent(this, ControlService.class));
            }
            getSharedPreferences("MainActivity", MODE_PRIVATE)
                .edit()
                .putString("token", pendingToken)
                .putString("computer", pendingComputer)
                .apply();
            pendingToken = null;
            startServiceNow();
            render();
          });
    } else if (!trusted.isEmpty()) {
      serviceButton = button(connection, "连接电脑服务", true, view -> startServiceNow());
    }
    serviceError = text(connection, "", 13, RED);
    serviceError.setVisibility(View.GONE);

    sessionCard = card(page);
    text(sessionCard, "当前会话", 18, INK);
    sessionDetails = text(sessionCard, "", 14, MUTED);
    LinearLayout actions = row();
    sessionCard.addView(actions);
    pauseButton = button(actions, "暂停当前会话", false, view -> {
      if (ControlService.current != null) ControlService.current.localControl("pause");
      update();
    });
    LinearLayout.LayoutParams pauseParams = new LinearLayout.LayoutParams(0, -2, 1);
    pauseParams.topMargin = dp(9);
    pauseParams.setMarginEnd(dp(8));
    pauseButton.setLayoutParams(pauseParams);
    TextView stop = button(actions, "结束控制", false, view -> {
      if (ControlService.current != null) ControlService.current.localControl("stop");
      update();
    });
    LinearLayout.LayoutParams stopParams = new LinearLayout.LayoutParams(0, -2, 1);
    stopParams.topMargin = dp(9);
    stop.setLayoutParams(stopParams);
    danger(stop);

    LinearLayout readiness = card(page);
    text(readiness, "手机控制准备情况", 18, INK);
    readinessSummary = text(readiness, "正在检查…", 14, BLUE);
    readinessSummary.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
    connectionState = diagnosticRow(readiness, "电脑连接与授权", "以最近的实际连接为准。只完成配对不代表电脑当前在线。");
    developerState = diagnosticRow(readiness, "开发者选项", "USB 调试和无线调试的系统设置入口。");
    usbState = diagnosticRow(readiness, "USB 调试", "使用 USB 时需要开启，并在手机弹窗中允许此电脑。");
    ((View) developerState.getParent()).setOnClickListener(view -> PhoneSettings.openDeveloperOptions(this));
    ((View) developerState.getParent()).setFocusable(true);
    ((View) usbState.getParent()).setOnClickListener(view -> PhoneSettings.openUsbDebugging(this));
    ((View) usbState.getParent()).setFocusable(true);
    wirelessState = diagnosticRow(readiness, "Wi-Fi 无线调试", "仅无线连接时需要：开启后与电脑配对，再建立连接。");
    ((View) wirelessState.getParent()).setOnClickListener(view -> PhoneSettings.openWirelessDebugging(this));
    ((View) wirelessState.getParent()).setFocusable(true);
    unlockState = diagnosticRow(readiness, "屏幕解锁", "开始或继续控制前，需要先解锁手机。");
    text(readiness, "USB 与 Wi-Fi 任选一种即可，无需同时开启。手机会自动检测并上报开关状态；未能确认时会说明原因，也可打开开发者选项查看。", 12, MUTED);
    button(readiness, "检查开发者选项", false, view -> PhoneSettings.openDeveloperOptions(this));
    text(readiness, "USB 无法连接时：检查数据线、调试授权；Windows 还可能需要手机厂商的 ADB 驱动，macOS 通常无需额外驱动。", 12, MUTED);

    LinearLayout permissions = card(page);
    LinearLayout heading = row();
    permissions.addView(heading);
    TextView title = text(heading, "App 所需权限", 18, INK);
    title.setTypeface(null, Typeface.BOLD);
    title.setLayoutParams(new LinearLayout.LayoutParams(0, -2, 1));
    permissionCount = text(heading, "", 12, MUTED);
    permissionRow(permissions, 0, "电脑操作时，在屏幕顶部持续显示控制者。",
        view ->
            startActivity(
                new Intent(
                    Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:" + getPackageName()))));
    divider(permissions);
    permissionRow(permissions, 1, "在通知栏查看控制状态，随时暂停或结束。",
        view -> {
          if (Build.VERSION.SDK_INT >= 33
              && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                  != android.content.pm.PackageManager.PERMISSION_GRANTED)
            requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, 1);
          else
            startActivity(
                new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName()));
        });
    divider(permissions);
    permissionRow(permissions, 2, "读取界面、截图、点击与输入。请在系统无障碍的已安装服务中，开启「ProfilePilot 手机控制」。已开启但未运行时，检查该服务或尝试重新开启。",
        view -> PhoneSettings.openAccessibility(this));
    text(permissions, "授权后，可在获准会话中读取屏幕、截图、点击和输入。密码输入框不会出现在页面快照中。", 12, MUTED);

    LinearLayout wireless = card(page);
    text(wireless, "用 Wi-Fi 连接电脑", 18, INK);
    text(wireless, "无需 USB，手机和电脑处于同一局域网即可。电脑接同一路由器的网线也可以。", 13, MUTED);
    button(wireless, "定位并开启无线调试", false, view -> PhoneSettings.openWirelessDebugging(this));
    text(wireless, "1  在电脑打开 ProfilePilot → 手机 → 无线连接手机。", 14, INK);
    text(wireless, "2  点击上方按钮可定位无线调试；已开启无障碍服务时会自动打开开关。系统询问时确认允许当前网络，再选择「使用配对码配对」。", 14, INK);
    text(wireless, "3  在电脑填入配对弹窗中的地址、端口和 6 位配对码，保持弹窗打开直到配对成功。", 14, INK);
    text(wireless, "4  返回「无线调试」主页面，将「IP 地址和端口」填入电脑的连接步骤，再连接手机 App。", 14, INK);
    text(wireless, "连接端口通常不同于配对端口。更换网络后可在电脑选择「已配对，直接连接」，使用手机最新显示的地址。", 12, MUTED);
    text(wireless, "找不到开发者选项时，在「关于手机」连续点击版本号，按系统提示开启。无线配对不会自动开始控制。", 12, MUTED);
    if (getIntent().getBooleanExtra("wirelessGuide", false)) scroll.post(() -> scroll.scrollTo(0, wireless.getTop()));

    if (!trusted.isEmpty()) {
      LinearLayout disconnect = card(page);
      text(disconnect, "连接管理", 18, INK);
      text(disconnect, "取消配对将结束当前控制；再次连接需要你重新授权。", 13, MUTED);
      TextView forget = button(disconnect, "断开并取消配对", false,
        view -> {
          if (ControlService.current != null) ControlService.current.localControl("stop");
          stopService(new Intent(this, ControlService.class));
          getSharedPreferences("MainActivity", MODE_PRIVATE).edit().clear().apply();
          pendingToken = null;
          render();
        });
      danger(forget);
    }
    LinearLayout about = column();
    about.setPadding(0, dp(16), 0, 0);
    page.addView(about);
    text(
        about,
        "此 App 只管理经过 ProfilePilot 的会话。其他应用直接使用 ADB 的操作不会被它接管。锁屏或连接中断会停止接受控制指令，重连后不会自动恢复。",
        12,
        MUTED);
    update();
  }

  private boolean startServiceNow() {
    try {
      if (serviceError != null) serviceError.setVisibility(View.GONE);
      startForegroundService(new Intent(this, ControlService.class));
      return true;
    } catch (Exception error) {
      serviceError.setText("连接失败：" + error.getMessage());
      serviceError.setVisibility(View.VISIBLE);
      return false;
    }
  }

  private void update() {
    if (status == null) return;
    PhoneReadiness readiness = new PhoneReadiness(this);
    boolean[] allowed = {readiness.overlay, readiness.notifications, readiness.accessibilityService.equals("running")};
    int count = 0;
    for (int i = 0; i < allowed.length; i++) {
      if (allowed[i]) count++;
      setText(permissionStates[i], allowed[i] ? "已开启  ›" : "去开启  ›");
      permissionStates[i].setTextColor(allowed[i] ? GREEN : BLUE);
      permissionStates[i].setTypeface(null, allowed[i] ? Typeface.BOLD : Typeface.NORMAL);
      permissionRows[i].setContentDescription(PERMISSION_NAMES[i]
          + (allowed[i] ? "，已开启，管理权限" : "，待开启，前往设置"));
    }
    setText(permissionStates[2], readiness.accessibilityLabel() + "  ›");
    permissionRows[2].setContentDescription("无障碍服务，" + readiness.accessibilityLabel() + "，前往设置");
    setText(permissionCount, count + " / 3 已就绪");
    permissionCount.setTextColor(count == 3 ? GREEN : MUTED);
    String trusted = getSharedPreferences("MainActivity", MODE_PRIVATE).getString("token", "");
    boolean pairing = pendingToken != null && !pendingToken.equals(trusted);
    ControlService service = ControlService.current;
    SessionState session = service == null ? null : service.session;
    boolean active = session != null && session.active();
    setText(status, pairing ? "请求与你的手机配对，请确认是你认识的电脑。"
        : trusted.isEmpty() ? "在电脑端 ProfilePilot 的「手机」页面发起连接。"
        : service == null ? "已配对 · 连接服务未启动"
        : session.phase.equals("idle") ? "连接服务已开启 · 等待电脑会话"
        : service.description());
    status.setTextColor(active && !pairing ? GREEN : BLUE);
    if (serviceButton != null) serviceButton.setVisibility(service == null ? View.VISIBLE : View.GONE);
    boolean ongoing = session != null && session.sessionId != null
        && !session.phase.equals("idle") && !session.phase.equals("stopped");
    sessionCard.setVisibility(ongoing ? View.VISIBLE : View.GONE);
    if (ongoing) setText(sessionDetails,
        "控制者：" + (session.controller.isEmpty() ? "电脑" : session.controller)
        + "\n任务：" + (session.task.isEmpty() ? "手机会话" : session.task));
    boolean paused = session != null && session.phase.equals("paused");
    setText(connectionState, readiness.connectionLabel());
    connectionState.setTextColor(readiness.computerConnected ? GREEN : MUTED);
    setText(developerState, readiness.debugLabel("developerOptions"));
    developerState.setTextColor(readiness.developerOptions.equals("enabled") ? GREEN : MUTED);
    setText(usbState, readiness.usbConnected ? "已开启 · 当前已连接" : readiness.debugLabel("usbDebugging"));
    usbState.setTextColor(readiness.usbDebugging.equals("enabled") ? GREEN : MUTED);
    setText(wirelessState, readiness.debugLabel("wirelessDebugging")
        + (readiness.wifiConnected ? " · 无线连接在线" : readiness.usbConnected ? " · 当前使用 USB" : ""));
    wirelessState.setTextColor(readiness.wirelessDebugging.equals("enabled") ? GREEN : MUTED);
    setText(unlockState, readiness.unlocked ? "已解锁" : "已锁屏 · 请先解锁");
    unlockState.setTextColor(readiness.unlocked ? GREEN : BLUE);
    java.util.ArrayList<String> missing = new java.util.ArrayList<>();
    if (trusted.isEmpty() || pairing) missing.add("允许电脑配对");
    if (!readiness.computerConnected) missing.add("连接电脑");
    if (!readiness.overlay) missing.add("开启悬浮窗");
    if (!readiness.notifications) missing.add("开启通知");
    if (!allowed[2]) missing.add(readiness.accessibilityService.equals("disabled") ? "开启无障碍服务" : "检查无障碍服务");
    if (!readiness.unlocked) missing.add("解锁手机");
    setText(readinessSummary, missing.isEmpty()
        ? paused ? "权限与连接已就绪 · 会话已暂停，需手动继续。" : "权限与连接已就绪。"
        : "待完成：" + String.join("、", missing) + "。");
    readinessSummary.setTextColor(missing.isEmpty() ? GREEN : BLUE);
    setText(pauseButton, paused ? "继续当前会话" : "暂停当前会话");
    pauseButton.setEnabled(active || paused);
    pauseButton.setAlpha(active || paused ? 1f : .45f);
    if (service != null) {
      Runnable toggle = service.pauseOrResumeAction();
      pauseButton.setOnClickListener(view -> { toggle.run(); update(); });
    }
  }

  private int dp(int value) {
    return Math.round(value * getResources().getDisplayMetrics().density);
  }

  private TextView diagnosticRow(LinearLayout parent, String label, String description) {
    divider(parent);
    LinearLayout heading = row();
    parent.addView(heading);
    TextView name = text(heading, label, 15, INK);
    name.setLayoutParams(new LinearLayout.LayoutParams(0, -2, 1));
    name.setPadding(0, dp(8), dp(8), dp(5));
    TextView value = text(heading, "正在检测", 13, MUTED);
    value.setTypeface(null, Typeface.BOLD);
    value.setMaxWidth(dp(180));
    text(parent, description, 12, MUTED);
    return value;
  }

  private LinearLayout column() {
    LinearLayout layout = new LinearLayout(this);
    layout.setOrientation(LinearLayout.VERTICAL);
    return layout;
  }

  private LinearLayout row() {
    LinearLayout layout = new LinearLayout(this);
    layout.setOrientation(LinearLayout.HORIZONTAL);
    layout.setGravity(Gravity.CENTER_VERTICAL);
    return layout;
  }

  private GradientDrawable background(int color, int radius, boolean border) {
    GradientDrawable shape = new GradientDrawable();
    shape.setColor(color);
    shape.setCornerRadius(dp(radius));
    if (border) shape.setStroke(dp(1), LINE);
    return shape;
  }

  private RippleDrawable ripple(int color, int radius, boolean border) {
    return new RippleDrawable(ColorStateList.valueOf(0x223976ed),
        background(color, radius, border), background(Color.WHITE, radius, false));
  }

  private LinearLayout card(LinearLayout parent) {
    LinearLayout card = column();
    card.setPadding(dp(18), dp(16), dp(18), dp(16));
    card.setBackground(background(Color.WHITE, 16, true));
    LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
    params.topMargin = dp(16);
    parent.addView(card, params);
    return card;
  }

  private TextView text(LinearLayout parent, String value, int size, int color) {
    TextView text = new TextView(this);
    text.setText(value);
    text.setTextSize(size);
    text.setTextColor(color);
    text.setPadding(0, dp(5), 0, dp(5));
    text.setLineSpacing(dp(3), 1);
    if (size >= 20) text.setTypeface(null, Typeface.BOLD);
    parent.addView(text);
    return text;
  }

  private TextView button(LinearLayout parent, String label, boolean primary, View.OnClickListener listener) {
    TextView button = new TextView(this);
    button.setText(label);
    button.setTextSize(14);
    button.setTextColor(primary ? Color.WHITE : BLUE);
    button.setTypeface(null, Typeface.BOLD);
    button.setGravity(Gravity.CENTER);
    button.setPadding(dp(15), dp(12), dp(15), dp(12));
    button.setMinHeight(dp(48));
    button.setBackground(ripple(primary ? BLUE : SOFT_BLUE, 10, false));
    button.setFocusable(true);
    button.setContentDescription(label);
    button.setAccessibilityDelegate(new View.AccessibilityDelegate() {
      @Override public void onInitializeAccessibilityNodeInfo(View host, android.view.accessibility.AccessibilityNodeInfo info) {
        super.onInitializeAccessibilityNodeInfo(host, info);
        info.setClassName(Button.class.getName());
      }
    });
    button.setOnClickListener(listener);
    LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
    params.topMargin = dp(9);
    parent.addView(button, params);
    return button;
  }

  private void danger(TextView button) {
    button.setTextColor(RED);
    button.setBackground(ripple(0xffffedf0, 10, false));
  }

  private void permissionRow(LinearLayout parent, int index, String description, View.OnClickListener action) {
    LinearLayout item = column();
    item.setPadding(0, dp(10), 0, dp(10));
    item.setBackground(ripple(Color.WHITE, 10, false));
    item.setFocusable(true);
    item.setOnClickListener(action);
    parent.addView(item, new LinearLayout.LayoutParams(-1, -2));
    LinearLayout heading = row();
    item.addView(heading);
    TextView name = text(heading, PERMISSION_NAMES[index], 16, INK);
    name.setTypeface(null, Typeface.BOLD);
    name.setLayoutParams(new LinearLayout.LayoutParams(0, -2, 1));
    name.setPadding(0, dp(5), dp(8), dp(5));
    permissionStates[index] = text(heading, "", 12, BLUE);
    text(item, description, 13, MUTED);
    permissionRows[index] = item;
  }

  private void divider(LinearLayout parent) {
    View line = new View(this);
    line.setBackgroundColor(LINE);
    parent.addView(line, new LinearLayout.LayoutParams(-1, dp(1)));
  }

  private void setText(TextView view, String value) {
    if (!value.contentEquals(view.getText())) view.setText(value);
  }

  @Override
  protected void onResume() {
    super.onResume();
    handler.removeCallbacks(refresh);
    handler.post(refresh);
  }

  @Override
  protected void onPause() {
    handler.removeCallbacks(refresh);
    super.onPause();
  }
}
