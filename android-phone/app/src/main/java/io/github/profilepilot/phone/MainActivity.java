package io.github.profilepilot.phone;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.*;
import android.provider.Settings;
import android.text.*;
import android.view.*;
import android.view.inputmethod.InputMethodManager;
import android.widget.*;
import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import com.journeyapps.barcodescanner.ScanContract;
import com.journeyapps.barcodescanner.ScanOptions;
import java.io.OutputStream;
import java.util.*;
import java.util.concurrent.*;
import org.json.*;

/** Native mobile workbench. The paired computer remains the task authority. */
public final class MainActivity extends ComponentActivity {
  private static final int BLUE = 0xff3976ed,
      INK = 0xff233047,
      MUTED = 0xff718097,
      BG = 0xfff6f8fc,
      LINE = 0xffe5ebf4;
  private final Handler main = new Handler(Looper.getMainLooper());
  private final ExecutorService io = Executors.newSingleThreadExecutor();
  private ComputerStore store;
  private JSONObject computer, sync = new JSONObject(), detail;
  private JSONArray taskList = new JSONArray();
  private final LinkedHashMap<String, JSONObject> events = new LinkedHashMap<>();
  private LinearLayout page, body, taskCards, eventCards, decisionCard, resultCard, detailActions;
  private TextView connection, notice, taskHeading, streamText, modelInfo;
  private TextView localStatus, localComputer, localReadiness, localSession, localPause, localStop, localServiceButton;
  private final TextView[] localChecks = new TextView[8];
  private final View[] localCheckRows = new View[8];
  private static final String[] LOCAL_CHECK_NAMES = {"电脑连接", "开发者选项", "USB 调试", "Wi-Fi 无线调试", "屏幕解锁", "悬浮窗 · 顶部胶囊", "控制状态通知", "无障碍服务"};
  private EditText prompt, followup;
  private Spinner profiles, mode;
  private String tab = "首页",
      taskId = "",
      filter = "全部",
      query = "",
      lastDecision = "",
      lastResult = "",
      lastEvents = "",
      lastTaskCards = "",
      sharedText = "";
  private int cursor = 0, revision = 0, totalTasks = 0;
  private boolean polling = false, hasMore = false, busy = false;
  private byte[] download;
  private final Runnable localTick = new Runnable() {
    @Override public void run() {
      updateLocalControl();
      main.postDelayed(this, 1000);
    }
  };
  private final Runnable tick =
      new Runnable() {
        public void run() {
          refresh(false);
          main.postDelayed(this, 4000);
        }
      };
  private final ActivityResultLauncher<ScanOptions> scanner =
      registerForActivityResult(
          new ScanContract(),
          result -> {
            if (result.getContents() != null) pair(result.getContents());
          });
  private final ActivityResultLauncher<String> saveFile =
      registerForActivityResult(
          new ActivityResultContracts.CreateDocument("application/octet-stream"),
          uri -> {
            if (uri != null && download != null) {
              byte[] data = download;
              io.execute(
                  () -> {
                    try (OutputStream out = getContentResolver().openOutputStream(uri)) {
                      if (out == null) throw new IllegalStateException("无法保存文件");
                      out.write(data);
                      main.post(() -> message("文件已保存"));
                    } catch (Exception error) {
                      main.post(() -> message(error.getMessage()));
                    }
                  });
            }
            download = null;
          });

  @Override
  public void onCreate(Bundle state) {
    super.onCreate(state);
    store = new ComputerStore(this);
    getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
      @Override public void handleOnBackPressed() {
        if (!taskId.isEmpty()) switchTab("任务");
        else if (!tab.equals("首页")) switchTab("首页");
        else { setEnabled(false); getOnBackPressedDispatcher().onBackPressed(); setEnabled(true); }
      }
    });
    getWindow().setStatusBarColor(BG);
    getWindow().setNavigationBarColor(Color.WHITE);
    getWindow()
        .getDecorView()
        .setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
    if (state != null) {
      tab = state.getString("tab", "首页");
      taskId = state.getString("taskId", "");
    }
    loadComputer();
    consumeIntent();
    render();
  }

  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    setIntent(intent);
    consumeIntent();
    render();
    refresh(true);
  }

  private void consumeIntent() {
    Intent intent = getIntent();
    String token = intent.getStringExtra("token");
    if (token != null) {
      tab = "首页";
      taskId = "";
      Intent local =
          new Intent(this, PermissionsActivity.class)
              .putExtra("token", token)
              .putExtra("computer", intent.getStringExtra("computer"));
      intent.removeExtra("token");
      intent.removeExtra("computer");
      startActivity(local);
    }
    String pc = intent.getStringExtra("computerId");
    if (pc != null) {
      store.select(pc);
      loadComputer();
      taskId = intent.getStringExtra("taskId");
      if (taskId == null) taskId = "";
      tab = "任务";
      intent.removeExtra("computerId");
      intent.removeExtra("taskId");
    }
    if (Intent.ACTION_SEND.equals(intent.getAction())) {
      String value = intent.getStringExtra(Intent.EXTRA_TEXT);
      if (value != null) {
        sharedText = value.substring(0, Math.min(value.length(), 30000));
        tab = "Agent";
        taskId = "";
      }
      intent.setAction(null);
      intent.removeExtra(Intent.EXTRA_TEXT);
    }
    Uri data = intent.getData();
    if (data != null && ("pair".equals(data.getHost()) || "status".equals(data.getHost()))) {
      intent.setData(null);
      main.post(() -> pair(data.toString()));
    }
  }

  private void loadComputer() {
    saveDraft();
    prompt = null;
    try {
      computer = store.find(store.selected());
      if (computer == null) {
        JSONArray all = store.all();
        computer = all.length() > 0 ? all.getJSONObject(0) : null;
        if (computer != null) store.select(computer.getString("id"));
      }
    } catch (Exception error) {
      computer = null;
      main.post(() -> message("电脑凭据无法读取，请重新配对：" + error.getMessage()));
    }
    sync = new JSONObject();
    taskList = new JSONArray();
    detail = null;
    events.clear();
    cursor = 0;
    revision = 0;
  }

  private String pcId() {
    return computer == null ? "" : computer.optString("id");
  }

  private int dp(int value) {
    return Math.round(value * getResources().getDisplayMetrics().density);
  }

  private GradientDrawable background(int color, int radius, boolean border) {
    GradientDrawable shape = new GradientDrawable();
    shape.setColor(color);
    shape.setCornerRadius(dp(radius));
    if (border) shape.setStroke(dp(1), LINE);
    return shape;
  }

  private LinearLayout column() {
    LinearLayout out = new LinearLayout(this);
    out.setOrientation(LinearLayout.VERTICAL);
    return out;
  }

  private LinearLayout row() {
    LinearLayout out = new LinearLayout(this);
    out.setOrientation(LinearLayout.HORIZONTAL);
    out.setGravity(Gravity.CENTER_VERTICAL);
    return out;
  }

  private TextView text(LinearLayout parent, String value, int size, int color) {
    TextView view = new TextView(this);
    view.setText(value);
    view.setTextSize(size);
    view.setTextColor(color);
    view.setLineSpacing(dp(3), 1);
    view.setPadding(0, dp(5), 0, dp(5));
    if (size >= 20) view.setTypeface(null, Typeface.BOLD);
    parent.addView(view);
    return view;
  }

  private TextView button(LinearLayout parent, String label, boolean primary, Runnable action) {
    TextView view = new TextView(this);
    view.setText(label);
    view.setTextColor(primary ? Color.WHITE : BLUE);
    view.setTextSize(14);
    view.setTypeface(null, Typeface.BOLD);
    view.setGravity(Gravity.CENTER);
    view.setPadding(dp(15), dp(12), dp(15), dp(12));
    view.setMinHeight(dp(48));
    view.setBackground(background(primary ? BLUE : 0xffedf3ff, 10, false));
    view.setClickable(true);
    view.setFocusable(true);
    view.setContentDescription(label);
    view.setOnClickListener(v -> action.run());
    LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
    params.topMargin = dp(9);
    parent.addView(view, params);
    return view;
  }

  private LinearLayout card(LinearLayout parent) {
    LinearLayout out = column();
    out.setPadding(dp(18), dp(16), dp(18), dp(16));
    out.setBackground(background(Color.WHITE, 16, true));
    LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
    params.topMargin = dp(16);
    parent.addView(out, params);
    return out;
  }

  private EditText input(LinearLayout parent, String hint, String value, int lines) {
    EditText edit = new EditText(this);
    edit.setTextColor(INK);
    edit.setHintTextColor(0xff94a1b4);
    edit.setTextSize(15);
    edit.setHint(hint);
    edit.setText(value);
    edit.setGravity(Gravity.TOP);
    edit.setMinLines(lines);
    edit.setMaxLines(Math.max(lines, 8));
    edit.setPadding(dp(12), dp(12), dp(12), dp(12));
    edit.setBackground(background(BG, 10, true));
    edit.setInputType(
        android.text.InputType.TYPE_CLASS_TEXT
            | android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE
            | android.text.InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
    edit.setFilters(new InputFilter[] {new InputFilter.LengthFilter(30000)});
    LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
    params.topMargin = dp(9);
    parent.addView(edit, params);
    return edit;
  }

  private void watch(EditText field, java.util.function.Consumer<String> changed) {
    field.addTextChangedListener(
        new TextWatcher() {
          public void beforeTextChanged(CharSequence s, int start, int count, int after) {}

          public void onTextChanged(CharSequence s, int start, int before, int count) {
            changed.accept(s.toString());
          }

          public void afterTextChanged(Editable e) {}
        });
  }

  private void saveDraft() {
    if (prompt != null) store.draft(pcId(), prompt.getText().toString());
  }

  private void switchTab(String name) {
    saveDraft();
    tab = name;
    taskId = "";
    detail = null;
    render();
    refresh(true);
  }

  private void render() {
    saveDraft();
    prompt = null;
    modelInfo = null;
    localStatus = localComputer = localReadiness = localSession = localPause = localStop = localServiceButton = null;
    lastTaskCards = "";
    page = column();
    page.setBackgroundColor(BG);
    page.setOnApplyWindowInsetsListener(
        (view, insets) -> {
          android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars());
          view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
          return insets;
        });
    LinearLayout top = column();
    top.setPadding(dp(22), dp(16), dp(22), dp(12));
    page.addView(top);
    LinearLayout branding = row();
    top.addView(branding);
    TextView brand = text(branding, "◈  ProfilePilot", 20, INK);
    brand.setLayoutParams(new LinearLayout.LayoutParams(0, -2, 1));
    TextView refresh = text(branding, "刷新", 13, BLUE);
    refresh.setMinHeight(dp(48));
    refresh.setGravity(Gravity.CENTER);
    refresh.setPadding(dp(12), 0, 0, 0);
    refresh.setOnClickListener(v -> refresh(true));
    refresh.setContentDescription("刷新工作区");
    connection =
        text(
            top,
            computer == null ? "○  尚未连接电脑" : "○  " + computer.optString("name") + " · 正在连接",
            12,
            MUTED);
    connection.setOnClickListener(v -> switchTab("设备"));
    notice = text(top, "", 12, 0xffac5c27);
    notice.setVisibility(View.GONE);
    ScrollView scroll = new ScrollView(this);
    scroll.setFillViewport(true);
    scroll.setClipToPadding(false);
    body = column();
    body.setFocusableInTouchMode(true);
    body.setPadding(dp(22), dp(8), dp(22), dp(28));
    scroll.addView(body);
    page.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
    LinearLayout nav = row();
    nav.setPadding(dp(8), dp(8), dp(8), dp(10));
    nav.setBackgroundColor(Color.WHITE);
    String[] labels = {"首页", "Agent", "任务", "设备", "我的"}, icons = {"⌂", "✦", "☷", "▣", "◎"};
    for (int i = 0; i < labels.length; i++) {
      String label = labels[i];
      TextView item = new TextView(this);
      item.setText(icons[i] + "\n" + label);
      item.setTextSize(13);
      item.setLineSpacing(dp(4), 1);
      item.setGravity(Gravity.CENTER);
      item.setTextColor(label.equals(tab) ? BLUE : MUTED);
      item.setMinHeight(dp(56));
      item.setContentDescription(label);
      item.setClickable(true);
      item.setFocusable(true);
      if (label.equals(tab)) item.setBackground(background(0xffedf3ff, 12, false));
      item.setOnClickListener(v -> switchTab(label));
      nav.addView(item, new LinearLayout.LayoutParams(0, -2, 1));
    }
    page.addView(nav);
    setContentView(page);
    taskCards = null;
    eventCards = null;
    profiles = null;
    followup = null;
    decisionCard = null;
    resultCard = null;
    if (!taskId.isEmpty()) detailScreen();
    else if (tab.equals("首页")) homeScreen();
    else if (tab.equals("Agent")) agentScreen();
    else if (tab.equals("任务")) tasksScreen();
    else if (tab.equals("设备")) devicesScreen();
    else settingsScreen();
    updateConnection();
    pendingRequestBanner();
  }

  private void homeScreen() {
    text(body, "手机状态", 26, INK);
    localControlCard(true);
    LinearLayout steps = card(body);
    text(steps, "连接只需三步", 18, INK);
    text(steps, "1  用 USB 连接并允许 USB 调试，或通过同一局域网无线配对。", 14, INK);
    text(steps, "2  打开电脑端 ProfilePilot → 手机，选择这台设备并连接。", 14, INK);
    text(steps, "3  在手机确认电脑配对，开启悬浮窗、通知和无障碍服务。", 14, INK);
    text(steps, "连接和授权不会自动开始控制。电脑发起会话后，这里会显示控制者；你可以随时暂停或结束。", 12, MUTED);
    LinearLayout tasks = card(body);
    text(tasks, "也可以让电脑为你执行任务", 17, INK);
    text(tasks, "在 Agent 页发起任务，或在任务页查看进度和结果。", 13, MUTED);
    button(tasks, "打开 Agent", false, () -> switchTab("Agent"));
  }

  private void localControlCard(boolean prominent) {
    LinearLayout local = card(body);
    if (!prominent) text(local, "手机状态", 18, INK);
    localStatus = text(local, "正在检查本机状态…", 16, BLUE);
    localStatus.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
    localComputer = text(local, "", 13, MUTED);
    localReadiness = text(local, "", 13, MUTED);
    localSession = text(local, "", 13, INK);
    LinearLayout actions = row();
    local.addView(actions);
    localPause = button(actions, "暂停电脑控制", false, () -> {
      if (ControlService.current != null) ControlService.current.localControl("pause");
      updateLocalControl();
    });
    LinearLayout.LayoutParams pauseParams = new LinearLayout.LayoutParams(0, -2, 1);
    pauseParams.setMarginEnd(dp(8));
    localPause.setLayoutParams(pauseParams);
    localStop = button(actions, "结束手机控制", false, () -> {
      if (ControlService.current != null) ControlService.current.localControl("stop");
      updateLocalControl();
    });
    localStop.setLayoutParams(new LinearLayout.LayoutParams(0, -2, 1));
    localStop.setTextColor(0xffaa3446);
    localStop.setBackground(background(0xffffedf0, 10, false));
    localCheckRow(local, 0, null);
    localCheckRow(local, 1, () -> PhoneSettings.openDeveloperOptions(this));
    localCheckRow(local, 2, () -> PhoneSettings.openUsbDebugging(this));
    localCheckRow(local, 3, () -> PhoneSettings.openWirelessDebugging(this));
    localCheckRow(local, 4, null);
    localCheckRow(local, 5, () -> startActivity(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + getPackageName()))));
    localCheckRow(local, 6, () -> {
      if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
        requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, 1);
      else startActivity(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName()));
    });
    localCheckRow(local, 7, () -> PhoneSettings.openAccessibility(this));
    text(local, "USB 与 Wi-Fi 任选一种。无障碍服务开启后，点击调试项可自动定位并开启；系统授权和锁屏密码由你确认。", 12, MUTED);
    localServiceButton = button(local, "连接电脑服务", true, () -> {
      try { startForegroundService(new Intent(this, ControlService.class)); }
      catch (Exception error) { message("连接失败：" + error.getMessage()); }
    });
    button(local, "配对与连接管理", false, () -> startActivity(new Intent(this, PermissionsActivity.class)));
    button(local, "Wi-Fi 连接指南", false,
        () -> startActivity(new Intent(this, PermissionsActivity.class).putExtra("wirelessGuide", true)));
    updateLocalControl();
  }

  private void localCheckRow(LinearLayout parent, int index, Runnable action) {
    View divider = new View(this);
    divider.setBackgroundColor(LINE);
    parent.addView(divider, new LinearLayout.LayoutParams(-1, dp(1)));
    LinearLayout item = row();
    item.setMinimumHeight(dp(action == null ? 40 : 48));
    parent.addView(item, new LinearLayout.LayoutParams(-1, -2));
    TextView name = text(item, LOCAL_CHECK_NAMES[index], 14, INK);
    name.setPadding(0, dp(5), dp(8), dp(5));
    name.setLayoutParams(new LinearLayout.LayoutParams(0, -2, 1));
    localChecks[index] = text(item, "正在检测", 13, MUTED);
    localChecks[index].setMaxWidth(dp(170));
    localChecks[index].setGravity(Gravity.END);
    if (action != null) {
      item.setFocusable(true);
      item.setBackground(new android.graphics.drawable.RippleDrawable(android.content.res.ColorStateList.valueOf(0x223976ed), null, background(Color.WHITE, 8, false)));
      item.setOnClickListener(view -> action.run());
    }
    localCheckRows[index] = item;
  }

  private void updateLocalControl() {
    if (localStatus == null) return;
    SharedPreferences preferences = getSharedPreferences("MainActivity", MODE_PRIVATE);
    boolean paired = !preferences.getString("token", "").isEmpty();
    ControlService service = ControlService.current;
    SessionState session = service == null ? null : service.session;
    PhoneReadiness readiness = new PhoneReadiness(this);
    String phase = session == null ? "" : session.phase;
    boolean active = session != null && session.active();
    String status = !paired ? "等待电脑配对"
        : service == null ? "已配对 · 连接服务未启动"
        : phase.equals("idle") ? readiness.computerConnected ? "已连接，未控制" : "等待电脑连接"
        : service.description();
    setLocalText(localStatus, status);
    localStatus.setTextColor(active ? 0xff19755e : BLUE);
    setLocalText(localComputer, paired
        ? "已授权电脑：" + preferences.getString("computer", "电脑")
        : "请先在电脑端「手机」页面发起连接。");
    setLocalCheck(0, readiness.usbConnected && readiness.wifiConnected ? "USB 与无线已连接" : readiness.usbConnected ? "USB 已连接" : readiness.wifiConnected ? "无线已连接" : readiness.computerConnected ? "已连接" : "未连接", readiness.computerConnected);
    setLocalCheck(1, readiness.debugLabel("developerOptions"), readiness.developerOptions.equals("enabled"));
    setLocalCheck(2, readiness.debugLabel("usbDebugging"), readiness.usbDebugging.equals("enabled"));
    setLocalCheck(3, readiness.debugLabel("wirelessDebugging"), readiness.wirelessDebugging.equals("enabled"));
    setLocalCheck(4, readiness.unlocked ? "已解锁" : "已锁屏", readiness.unlocked);
    setLocalCheck(5, readiness.overlay ? "已开启" : "未开启", readiness.overlay);
    setLocalCheck(6, readiness.notifications ? "已开启" : "未开启", readiness.notifications);
    setLocalCheck(7, readiness.accessibilityLabel(), readiness.accessibilityService.equals("running"));
    ArrayList<String> missing = new ArrayList<>();
    if (!paired) missing.add("允许电脑配对");
    if (!readiness.computerConnected) missing.add("连接电脑");
    if (!readiness.overlay) missing.add("开启悬浮窗");
    if (!readiness.notifications) missing.add("开启通知");
    if (!readiness.accessibilityService.equals("running")) missing.add("检查无障碍服务");
    if (!readiness.unlocked) missing.add("解锁手机");
    setLocalText(localReadiness, missing.isEmpty() ? "权限与连接已就绪" : "待完成：" + String.join("、", missing));
    localReadiness.setTextColor(missing.isEmpty() ? 0xff19755e : BLUE);
    localServiceButton.setVisibility(paired && service == null ? View.VISIBLE : View.GONE);
    boolean ongoing = session != null && session.sessionId != null
        && !phase.equals("stopped") && !phase.equals("idle");
    localSession.setVisibility(ongoing ? View.VISIBLE : View.GONE);
    if (ongoing) setLocalText(localSession,
        "控制者：" + (session.controller.isEmpty() ? "电脑" : session.controller)
        + "\n任务：" + (session.task.isEmpty() ? "手机会话" : session.task));
    boolean paused = phase.equals("paused");
    setLocalText(localPause, paused ? "继续电脑控制" : "暂停电脑控制");
    localPause.setVisibility(active || paused ? View.VISIBLE : View.GONE);
    if (service != null) {
      Runnable toggle = service.pauseOrResumeAction();
      localPause.setOnClickListener(view -> { toggle.run(); updateLocalControl(); });
    }
    localStop.setVisibility(ongoing ? View.VISIBLE : View.GONE);
  }

  private void setLocalText(TextView view, String value) {
    if (!value.contentEquals(view.getText())) view.setText(value);
  }

  private void setLocalCheck(int index, String value, boolean ready) {
    setLocalText(localChecks[index], value);
    localChecks[index].setTextColor(ready ? 0xff19755e : MUTED);
    localChecks[index].setTypeface(null, ready ? Typeface.BOLD : Typeface.NORMAL);
    String action = index == 2 || index == 3 ? "，定位并开启" + LOCAL_CHECK_NAMES[index]
        : index == 7 ? "，打开本应用的无障碍设置" : "，打开系统设置";
    localCheckRows[index].setContentDescription(LOCAL_CHECK_NAMES[index] + "，" + value + (localCheckRows[index].isClickable() ? action : ""));
  }

  private void agentScreen() {
    text(body, "随时开始，\n让电脑为你执行。", 29, INK);
    text(body, "你的浏览器、登录状态与任务，始终在同一处。", 14, MUTED);
    LinearLayout composer = card(body);
    text(composer, "今天想完成什么？", 17, INK);
    String initial = !sharedText.isEmpty() ? sharedText : store.draft(pcId());
    sharedText = "";
    prompt = input(composer, "描述任务，或分享链接到这里…", initial, 5);
    watch(prompt, value -> store.draft(pcId(), value));
    text(composer, "执行 Profile", 12, MUTED);
    profiles = new Spinner(this);
    composer.addView(profiles, new LinearLayout.LayoutParams(-1, dp(48)));
    updateProfiles();
    text(composer, "执行方式", 12, MUTED);
    mode = new Spinner(this);
    mode.setAdapter(
        new ArrayAdapter<>(
            this,
            android.R.layout.simple_spinner_dropdown_item,
            new String[] {"按需确认 · 自动执行", "先制定计划", "每步手动确认"}));
    String savedMode = store.draft(pcId() + ":mode");
    mode.setSelection(savedMode.equals("plan") ? 1 : savedMode.equals("manual") ? 2 : 0);
    mode.setOnItemSelectedListener(
        new AdapterView.OnItemSelectedListener() {
          @Override
          public void onItemSelected(AdapterView<?> parent, View view, int position, long id) {
            store.draft(pcId() + ":mode", new String[] {"acceptEdits", "plan", "manual"}[position]);
          }

          @Override
          public void onNothingSelected(AdapterView<?> parent) {}
        });
    composer.addView(mode, new LinearLayout.LayoutParams(-1, dp(48)));
    modelInfo = text(composer, "模型：" + sync.optString("model", "使用电脑当前模型"), 12, MUTED);
    button(
        composer,
        "发送到电脑  ↗",
        true,
        () -> {
          if (!connected()) return;
          if (!sync.optBoolean("canControl", true)) {
            message("此手机当前仅可查看，请在电脑修改授权");
            return;
          }
          JSONArray available = sync.optJSONArray("profiles");
          int index = profiles.getSelectedItemPosition();
          JSONObject profile = available == null ? null : available.optJSONObject(index);
          String value = prompt.getText().toString().trim();
          if (value.isEmpty()) {
            prompt.setError("请描述任务");
            return;
          }
          if (profile == null || !profile.optBoolean("ready")) {
            message(
                profile == null ? "请选择可用 Profile" : profile.optString("reason", "此 Profile 暂不可用"));
            return;
          }
          String selectedMode =
              new String[] {"acceptEdits", "plan", "manual"}[mode.getSelectedItemPosition()];
          mutate(
              RemoteClient.object(
                  "action",
                  "task.create",
                  "profile",
                  profile.optString("id"),
                  "input",
                  RemoteClient.object("prompt", value, "mode", selectedMode)),
              false,
              result -> {
                store.draft(pcId(), "");
                if (prompt != null) prompt.setText("");
                openTask(result.optJSONObject("task").optString("id"));
              });
        });
    LinearLayout tips = card(body);
    text(tips, "从一个小任务开始", 15, INK);
    text(tips, "整理网页资料、比较产品、处理重复操作。任务需要确认时，你会在「任务」中看到。", 13, MUTED);
    if (computer == null) button(tips, "连接你的电脑", false, () -> switchTab("设备"));
  }

  private void updateProfiles() {
    if (profiles == null) return;
    JSONArray list = sync.optJSONArray("profiles");
    List<String> names = new ArrayList<>();
    List<String> ids = new ArrayList<>();
    if (list != null)
      for (int i = 0; i < list.length(); i++) {
        JSONObject p = list.optJSONObject(i);
        ids.add(p.optString("id"));
        names.add(p.optString("name") + (p.optBoolean("ready") ? "" : " · 暂不可用"));
      }
    if (names.isEmpty()) names.add("连接电脑后选择 Profile");
    String key = ids.toString() + names.toString();
    if (key.equals(profiles.getTag())) return;
    int selected = ids.indexOf(store.draft(pcId() + ":profile"));
    profiles.setOnItemSelectedListener(null);
    profiles.setAdapter(
        new ArrayAdapter<>(this, android.R.layout.simple_spinner_dropdown_item, names));
    profiles.setSelection(Math.max(0, selected));
    profiles.setTag(key);
    profiles.setOnItemSelectedListener(
        new AdapterView.OnItemSelectedListener() {
          @Override
          public void onItemSelected(AdapterView<?> parent, View view, int position, long id) {
            if (position >= 0 && position < ids.size()) store.draft(pcId() + ":profile", ids.get(position));
          }

          @Override
          public void onNothingSelected(AdapterView<?> parent) {}
        });
  }

  private void tasksScreen() {
    text(body, "任务", 29, INK);
    text(body, "从发起到完成，每一步都看得见。", 14, MUTED);
    EditText search = input(body, "搜索任务…", query, 1);
    watch(
        search,
        value -> {
          query = value;
          renderTaskCards();
        });
    Spinner filters = new Spinner(this);
    String[] values = {"全部", "进行中", "待确认", "已完成"};
    filters.setAdapter(
        new ArrayAdapter<>(this, android.R.layout.simple_spinner_dropdown_item, values));
    filters.setSelection(Arrays.asList(values).indexOf(filter));
    body.addView(filters, new LinearLayout.LayoutParams(-1, dp(48)));
    filters.setOnItemSelectedListener(
        new android.widget.AdapterView.OnItemSelectedListener() {
          public void onItemSelected(
              android.widget.AdapterView<?> p, View v, int position, long id) {
            filter = values[position];
            renderTaskCards();
          }

          public void onNothingSelected(android.widget.AdapterView<?> p) {}
        });
    taskCards = column();
    body.addView(taskCards);
    renderTaskCards();
  }

  private void renderTaskCards() {
    if (taskCards == null) return;
    String rendered = taskList.toString() + filter + query + totalTasks;
    if (lastTaskCards.equals(rendered)) return;
    lastTaskCards = rendered;
    taskCards.removeAllViews();
    int shown = 0;
    for (int i = 0; i < taskList.length(); i++) {
      JSONObject task = taskList.optJSONObject(i);
      String status = task.optString("status"), id = task.optString("id");
      if (!task.optString("title")
          .toLowerCase(Locale.ROOT)
          .contains(query.toLowerCase(Locale.ROOT))) continue;
      if (filter.equals("待确认") && !status.equals("waiting_user")) continue;
      if (filter.equals("进行中") && !Arrays.asList("running", "queued", "paused").contains(status))
        continue;
      if (filter.equals("已完成")
          && !Arrays.asList("completed", "partial", "failed", "cancelled").contains(status))
        continue;
      LinearLayout item = card(taskCards);
      text(
          item,
          statusLabel(status) + "  ·  " + task.optString("profileName"),
          12,
          status.equals("waiting_user") ? 0xffac5c27 : BLUE);
      text(item, task.optString("title"), 17, INK);
      text(item, task.optString("updatedAt").replace("T", " ").replace("Z", " UTC"), 11, MUTED);
      item.setOnClickListener(v -> openTask(id));
      item.setClickable(true);
      item.setFocusable(true);
      item.setContentDescription("打开任务：" + task.optString("title"));
      shown++;
    }
    if (shown == 0) {
      LinearLayout empty = card(taskCards);
      text(empty, computer == null ? "连接电脑，任务就会出现在这里" : "暂无匹配的任务", 17, INK);
      text(empty, "在 Agent 页发起一个任务，或刷新查看电脑上的记录。", 13, MUTED);
    }
    if (totalTasks > taskList.length()) button(taskCards, "加载更多任务", false, this::loadMoreTasks);
  }

  private void loadMoreTasks() {
    if (!connected() || busy) return;
    int offset = taskList.length();
    String pc = pcId();
    JSONObject target = computer;
    busy = true;
    io.execute(
        () -> {
          try {
            JSONObject data =
                RemoteClient.read(
                    target,
                    RemoteClient.object("action", "task.list", "offset", offset, "limit", 50));
            main.post(
                () -> {
                  busy = false;
                  if (!pc.equals(pcId())) return;
                  JSONArray next = data.optJSONArray("tasks");
                  for (int i = 0; next != null && i < next.length(); i++)
                    taskList.put(next.optJSONObject(i));
                  totalTasks = data.optInt("total");
                  renderTaskCards();
                });
          } catch (Exception e) {
            main.post(
                () -> {
                  busy = false;
                  message(e.getMessage());
                });
          }
        });
  }

  static String statusLabel(String value) {
    return switch (value) {
      case "running" -> "执行中";
      case "queued" -> "排队中";
      case "waiting_user" -> "等待确认";
      case "paused" -> "已暂停";
      case "completed" -> "已完成";
      case "partial" -> "部分完成";
      case "failed" -> "执行失败";
      case "cancelled" -> "已取消";
      default -> value;
    };
  }

  private void openTask(String id) {
    saveDraft();
    taskId = id;
    tab = "任务";
    detail = null;
    events.clear();
    cursor = 0;
    revision = 0;
    lastDecision = "";
    lastResult = "";
    lastEvents = "";
    render();
    refresh(true);
  }

  private void detailScreen() {
    button(body, "‹ 返回任务列表", false, () -> switchTab("任务"));
    taskHeading = text(body, detail == null ? "正在读取任务…" : detail.optString("title"), 23, INK);
    detailActions = row();
    body.addView(detailActions);
    decisionCard = card(body);
    decisionCard.setVisibility(View.GONE);
    resultCard = card(body);
    resultCard.setVisibility(View.GONE);
    eventCards = column();
    body.addView(eventCards);
    streamText = text(body, "", 14, MUTED);
    LinearLayout compose = card(body);
    followup = input(compose, "补充要求…", store.draft(pcId() + ":" + taskId), 2);
    watch(followup, value -> store.draft(pcId() + ":" + taskId, value));
    button(
        compose,
        "发送补充",
        true,
        () -> {
          String value = followup.getText().toString().trim();
          if (value.isEmpty()) return;
          String status = detail == null ? "" : detail.optString("status");
          String control =
              Arrays.asList("paused", "completed", "failed", "partial", "cancelled")
                      .contains(status)
                  ? "resume"
                  : "steer";
          mutate(
              RemoteClient.object(
                  "action", "task.control", "id", taskId, "control", control, "message", value),
              false,
              result -> {
                store.draft(pcId() + ":" + taskId, "");
                if (followup != null) followup.setText("");
                refresh(true);
              });
        });
    lastDecision = "";
    lastResult = "";
    lastEvents = "";
    updateDetail();
  }

  private void smallButton(LinearLayout row, String label, Runnable action) {
    TextView b = button(row, label, false, action);
    LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, -2, 1);
    params.setMargins(dp(3), dp(8), dp(3), 0);
    b.setLayoutParams(params);
  }

  private void updateDetail() {
    if (detail == null || eventCards == null) return;
    taskHeading.setText(detail.optString("title") + "\n" + statusLabel(detail.optString("status")));
    detailActions.removeAllViews();
    String status = detail.optString("status");
    if (Arrays.asList("running", "queued", "waiting_user").contains(status))
      smallButton(detailActions, "暂停", () -> control("pause"));
    if (Arrays.asList("paused", "failed", "partial", "completed", "cancelled").contains(status))
      smallButton(detailActions, "继续", () -> control("resume"));
    if (!Arrays.asList("completed", "cancelled", "failed").contains(status))
      smallButton(
          detailActions,
          "结束任务",
          () ->
              new AlertDialog.Builder(this)
                  .setTitle("结束这个任务？")
                  .setMessage("电脑会停止执行，已有记录与结果会保留。")
                  .setNegativeButton("返回", null)
                  .setPositiveButton("结束", (d, w) -> control("cancel"))
                  .show());
    JSONObject pending = detail.optJSONObject("pending");
    String decision = pending == null ? "" : pending.toString();
    if (!lastDecision.equals(decision)) {
      lastDecision = decision;
      decisionCard.removeAllViews();
      decisionCard.setVisibility(pending == null ? View.GONE : View.VISIBLE);
      if (pending != null) {
        text(decisionCard, "需要你的确认", 12, BLUE);
        text(decisionCard, pending.optString("title"), 18, INK);
        text(decisionCard, pending.optString("details"), 14, INK).setTextIsSelectable(true);
        if (pending.optJSONObject("action") != null)
          text(decisionCard, pending.optJSONObject("action").optString("summary"), 13, MUTED);
        if (pending.optJSONObject("terminal") != null)
          text(decisionCard, pending.optJSONObject("terminal").toString(), 12, INK)
              .setTextIsSelectable(true);
        EditText answer =
            input(decisionCard, "回答或补充说明…", store.draft(pcId() + ":" + pending.optString("id")), 2);
        watch(answer, value -> store.draft(pcId() + ":" + pending.optString("id"), value));
        String kind = pending.optString("kind");
        if (kind.equals("question"))
          button(
              decisionCard, "提交回答", true, () -> reply(pending, answer.getText().toString(), false));
        else {
          button(
              decisionCard,
              kind.equals("handoff") ? "已在电脑完成，交还 Agent" : "允许这一次",
              true,
              () -> reply(pending, answer.getText().toString(), true));
          if (!kind.equals("handoff"))
            button(
                decisionCard,
                "拒绝操作",
                false,
                () -> reply(pending, answer.getText().toString(), false));
        }
      }
    }
    String results =
        detail.optString("result") + detail.optString("outputs") + detail.optString("items");
    if (!lastResult.equals(results)) {
      lastResult = results;
      resultCard.removeAllViews();
      JSONObject result = detail.optJSONObject("result");
      JSONArray outputs = detail.optJSONArray("outputs"), items = detail.optJSONArray("items");
      boolean visible =
          result != null
              || outputs != null && outputs.length() > 0
              || items != null && items.length() > 0;
      resultCard.setVisibility(visible ? View.VISIBLE : View.GONE);
      if (result != null) {
        text(resultCard, "任务结果", 17, INK);
        text(resultCard, result.optString("summary"), 14, INK).setTextIsSelectable(true);
        for (String field : new String[] {"evidence", "remaining"}) {
          JSONArray values = result.optJSONArray(field);
          if (values != null && values.length() > 0) {
            text(resultCard, field.equals("evidence") ? "依据" : "待完成", 12, BLUE);
            for (int i = 0; i < values.length(); i++)
              text(resultCard, values.optString(i), 13, MUTED).setTextIsSelectable(true);
          }
        }
      }
      if (items != null)
        for (int i = 0; i < items.length(); i++) {
          JSONObject item = items.optJSONObject(i);
          text(
              resultCard,
              item.optString("label") + " · " + statusLabel(item.optString("status")),
              13,
              INK);
          if (!item.optString("result").isEmpty())
            text(resultCard, item.optString("result"), 13, MUTED);
        }
      if (outputs != null)
        for (int i = 0; i < outputs.length(); i++) {
          JSONObject file = outputs.optJSONObject(i);
          button(resultCard, "↓  " + file.optString("name"), false, () -> artifact(file));
        }
    }
    String eventKey = events.toString() + hasMore;
    if (!lastEvents.equals(eventKey)) {
      lastEvents = eventKey;
      eventCards.removeAllViews();
      if (events.isEmpty()) text(eventCards, "正在等待电脑的执行记录…", 13, MUTED);
      for (JSONObject event : events.values()) {
        LinearLayout item = card(eventCards);
        String kind = event.optString("kind");
        text(
            item,
            kind.equals("user")
                ? "你"
                : kind.equals("assistant")
                    ? "Agent"
                    : kind.equals("error") ? "执行提示" : "进度 · " + kind,
            11,
            BLUE);
        text(item, event.optString("text"), 14, INK).setTextIsSelectable(true);
      }
      if (hasMore) button(eventCards, "加载后续记录", false, () -> refresh(true));
    }
  }

  private void control(String action) {
    mutate(
        RemoteClient.object("action", "task.control", "id", taskId, "control", action),
        false,
        result -> refresh(true));
  }

  private void reply(JSONObject pending, String answer, boolean approved) {
    if (pending.optString("kind").equals("question") && answer.trim().isEmpty()) {
      message("请填写回答");
      return;
    }
    mutate(
        RemoteClient.object(
            "action",
            "task.reply",
            "id",
            taskId,
            "decisionId",
            pending.optString("id"),
            "answer",
            answer,
            "approved",
            approved,
            "scope",
            "once"),
        false,
        result -> {
          store.draft(pcId() + ":" + pending.optString("id"), "");
          refresh(true);
        });
  }

  private void artifact(JSONObject file) {
    if (!connected()) return;
    String id = taskId;
    JSONObject target = computer;
    message("正在读取文件…");
    io.execute(
        () -> {
          try {
            JSONObject data =
                RemoteClient.read(
                    target,
                    RemoteClient.object(
                        "action", "task.artifact", "taskId", id, "fileId", file.optString("id")));
            byte[] bytes =
                android.util.Base64.decode(data.getString("base64"), android.util.Base64.DEFAULT);
            main.post(
                () -> {
                  if (isDestroyed()) return;
                  download = bytes;
                  saveFile.launch(data.optString("name", "result.bin"));
                });
          } catch (Exception e) {
            main.post(() -> message(e.getMessage()));
          }
        });
  }

  private void devicesScreen() {
    text(body, "连接你的工作区", 29, INK);
    text(body, "一台手机，随时连接你的多台电脑。", 14, MUTED);
    LinearLayout connect = card(body);
    text(connect, "添加电脑", 18, INK);
    text(connect, "电脑打开「手机 → 连接移动版」，生成二维码。", 13, MUTED);
    button(
        connect,
        "扫码连接电脑",
        true,
        () ->
            scanner.launch(
                new ScanOptions()
                    .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                    .setPrompt("扫描电脑上的 ProfilePilot 配对码")
                    .setBeepEnabled(false)
                    .setOrientationLocked(false)));
    button(
        connect,
        "粘贴配对链接",
        false,
        () -> {
          EditText entry = new EditText(this);
          entry.setHint("profilepilot://pair?…");
          new AlertDialog.Builder(this)
              .setTitle("粘贴配对链接")
              .setView(entry)
              .setNegativeButton("取消", null)
              .setPositiveButton("继续", (d, w) -> pair(entry.getText().toString()))
              .show();
        });
    try {
      JSONArray all = store.all();
      for (int i = 0; i < all.length(); i++) {
        JSONObject item = all.getJSONObject(i);
        String id = item.getString("id");
        LinearLayout card = card(body);
        text(card, item.optString("name") + (id.equals(pcId()) ? "  ·  当前电脑" : ""), 18, INK);
        text(card, item.optString("url"), 12, MUTED);
        if (!id.equals(pcId()))
          button(
              card,
              "切换到这台电脑",
              true,
              () -> {
                saveDraft();
                store.select(id);
                loadComputer();
                taskId = "";
                render();
                refresh(true);
              });
        button(card, "修改连接地址", false, () -> editAddress(item));
        button(card, "移除电脑与授权", false, () -> removeComputer(item));
      }
    } catch (Exception e) {
      text(body, e.getMessage(), 13, 0xffac5c27);
    }
    statusSyncCard();
    localControlCard(false);
  }

  private void settingsScreen() {
    text(body, "我的工作区", 29, INK);
    text(body, "让任务持续执行，让决定回到你手中。", 14, MUTED);
    LinearLayout notification = card(body);
    text(notification, "任务通知", 18, INK);
    text(notification, "保持后台连接，在任务需要确认或完成时提醒。系统省电策略或电脑离线可能延迟通知。", 13, MUTED);
    boolean enabled = store.notifications();
    button(
        notification,
        enabled ? "停止后台任务通知" : "开启后台任务通知",
        !enabled,
        () -> {
          if (enabled) {
            store.notifications(false);
            stopService(new Intent(this, RemoteSyncService.class));
            render();
          } else {
            if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                    != PackageManager.PERMISSION_GRANTED) {
              requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, 32);
              return;
            }
            enableNotifications();
          }
        });
    button(
        notification,
        "系统通知设置",
        false,
        () ->
            startActivity(
                new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName())));
    LinearLayout info = card(body);
    text(info, "ProfilePilot 移动版", 18, INK);
    text(
        info,
        "v0.2.0 · Android\n\n"
            + "电脑负责执行与保存任务。手机负责发起、查看和确认。关闭 App 或断开手机不会终止电脑任务。\n\n"
            + "连接信息仅存于本机，凭据由 Android Keystore 加密。你可随时在电脑撤销这台手机的授权。",
        14,
        MUTED);
    button(info, "管理已连接电脑", false, () -> switchTab("设备"));
    // The fixture activity is packaged only in debug APKs. Expose a local entry
    // so developer flows can open it through the same managed phone controls.
    if ((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
      button(info, "手机控制测试页", false, () -> startActivity(
          new Intent().setClassName(this, getPackageName() + ".ControlBenchmarkActivity")
              .putExtra("bench_reset", true)));
    }
  }

  private void enableNotifications() {
    if (!getSystemService(NotificationManager.class).areNotificationsEnabled()) {
      message("请先在系统设置中允许任务通知");
      return;
    }
    try {
      startForegroundService(new Intent(this, RemoteSyncService.class));
      store.notifications(true);
      render();
    } catch (Exception e) {
      message(e.getMessage());
    }
  }

  @Override
  public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
    super.onRequestPermissionsResult(request, permissions, results);
    if (request == 32 && results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED)
      enableNotifications();
  }

  private void editAddress(JSONObject item) {
    EditText entry = new EditText(this);
    entry.setText(item.optString("url"));
    new AlertDialog.Builder(this)
        .setTitle("电脑连接地址")
        .setMessage("可使用同一网络地址或可达的 VPN 地址。电脑身份仍须与首次配对一致。")
        .setView(entry)
        .setNegativeButton("取消", null)
        .setPositiveButton(
            "保存",
            (d, w) -> {
              try {
                item.put("url", RemoteClient.endpoint(entry.getText().toString()));
                store.save(item);
                if (item.optString("id").equals(pcId())) computer = item;
                render();
                refresh(true);
              } catch (Exception e) {
                message(e.getMessage());
              }
            })
        .show();
  }

  private void removeComputer(JSONObject item) {
    new AlertDialog.Builder(this)
        .setTitle("移除「" + item.optString("name") + "」？")
        .setMessage("会撤销此手机的连接授权。电脑上的任务会继续保留。")
        .setNegativeButton("取消", null)
        .setPositiveButton(
            "移除",
            (d, w) -> {
              io.execute(
                  () -> {
                    try {
                      RemoteClient.mutation(
                          store, item, RemoteClient.object("action", "device.disconnect"), false);
                      store.remove(item.getString("id"));
                      main.post(
                          () -> {
                            loadComputer();
                            render();
                          });
                    } catch (Exception e) {
                      main.post(
                          () ->
                              new AlertDialog.Builder(this)
                                  .setTitle("未能联系电脑")
                                  .setMessage(e.getMessage() + "\n\n可仅删除手机上的凭据；之后仍需在电脑撤销此手机授权。")
                                  .setNegativeButton("返回", null)
                                  .setPositiveButton(
                                      "仅从手机移除",
                                      (dialog, which) -> {
                                        try {
                                          store.remove(item.optString("id"));
                                          loadComputer();
                                          render();
                                        } catch (Exception error) {
                                          message(error.getMessage());
                                        }
                                      })
                                  .show());
                    }
                  });
            })
        .show();
  }

  private void pair(String value) {
    if ("status".equals(Uri.parse(value.trim()).getHost())) { pairStatus(value); return; }
    try {
      JSONObject target = RemoteClient.parsePair(value);
      new AlertDialog.Builder(this)
          .setTitle("连接「" + target.getString("name") + "」？")
          .setMessage(
              "地址："
                  + target.getString("url")
                  + "\n\n只连接你自己电脑上刚生成的配对码。配对后可以查看任务，并向该电脑发送操作。\n\n设备指纹："
                  + target.getString("fingerprint").substring(0, 16)
                  + "…")
          .setNegativeButton("取消", null)
          .setPositiveButton(
              "连接",
              (d, w) -> {
                message("正在安全连接…");
                io.execute(
                    () -> {
                      try {
                        JSONObject result =
                            RemoteClient.post(
                                target,
                                "/v1/pair",
                                RemoteClient.object(
                                    "token",
                                    target.getString("token"),
                                    "clientId",
                                    store.clientId(),
                                    "name",
                                    Build.MANUFACTURER + " " + Build.MODEL),
                                false);
                        if (!target.getString("id").equals(result.getString("computerId"))
                            || !target
                                .getString("fingerprint")
                                .equals(result.getString("fingerprint")))
                          throw new IllegalStateException("配对电脑身份不一致");
                        target
                            .put("token", result.getString("token"))
                            .put("deviceId", result.getString("deviceId"))
                            .put("name", result.getString("computerName"));
                        store.save(target);
                        store.select(target.getString("id"));
                        main.post(
                            () -> {
                              saveDraft();
                              loadComputer();
                              tab = "Agent";
                              taskId = "";
                              render();
                              refresh(true);
                            });
                      } catch (Exception error) {
                        main.post(() -> message("连接失败：" + error.getMessage()));
                      }
                    });
              })
          .show();
    } catch (Exception e) {
      message("无法识别配对信息：" + e.getMessage());
    }
  }

  private void pairStatus(String value) {
    try {
      JSONObject target = StatusSyncClient.parse(value);
      new AlertDialog.Builder(this).setTitle("开启手机状态同步")
          .setMessage("向服务器上报权限、锁屏、调试开关及当前 Wi-Fi 地址和发现的无线调试端口，帮助已绑定的电脑自动连接。不上传屏幕或控制凭据。\n\n服务器：" + target.getString("url") + "\n\n可在设备页或通知栏停止同步。")
          .setNegativeButton("取消", null).setPositiveButton("开启同步", (d, w) -> io.execute(() -> {
            try {
              StatusSyncClient.pair(this, target);
              main.post(() -> { startForegroundService(new Intent(this, StatusSyncService.class)); render(); message("状态同步已开启，电脑无需连接手机即可查看"); });
            } catch (Exception error) { main.post(() -> message("状态同步配对失败：" + error.getMessage())); }
          })).show();
    } catch (Exception error) { message("无法识别状态同步链接"); }
  }

  private void statusSyncCard() {
    LinearLayout panel = card(body);
    text(panel, "手机状态同步", 18, INK);
    text(panel, "同步权限和当前 Wi-Fi 连接地址，帮助电脑自动发现手机。状态同步无需同一 Wi-Fi；无线控制仍需同一局域网并完成配对。", 13, MUTED);
    try {
      org.json.JSONArray ips = WirelessNetwork.snapshot(this).getJSONArray("wifiIpv4");
      StringBuilder addresses = new StringBuilder();
      for (int i = 0; i < ips.length(); i++) { if (i > 0) addresses.append("、"); addresses.append(ips.getString(i)); }
      text(panel, ips.length() == 0 ? "当前未取得 Wi-Fi 局域网地址" : "当前 Wi-Fi IP：" + addresses, 13, MUTED);
    } catch (Exception ignored) { }
    try {
      JSONObject link = store.statusLink(false);
      if (link == null) { text(panel, "电脑打开「手机 → 连接手机 → 通过服务器同步状态」，在本页扫码或粘贴配对链接。", 13, MUTED); return; }
      text(panel, link.getString("url"), 12, MUTED);
      boolean enabled = store.statusEnabled();
      text(panel, enabled ? StatusSyncService.message : "同步已停止", 14, MUTED);
      if (StatusSyncService.lastReportedAt > 0) text(panel, "最后上报：" + java.text.DateFormat.getTimeInstance().format(new java.util.Date(StatusSyncService.lastReportedAt)), 12, MUTED);
      button(panel, enabled ? "停止状态同步" : "开启状态同步", !enabled, () -> {
        store.statusEnabled(!enabled);
        if (enabled) stopService(new Intent(this, StatusSyncService.class));
        else startForegroundService(new Intent(this, StatusSyncService.class));
        render();
      });
    } catch (Exception error) { text(panel, "同步配置无法读取，请重新扫码", 13, MUTED); }
  }

  private boolean connected() {
    if (computer == null) {
      message("请先在设备页连接电脑");
      return false;
    }
    return true;
  }

  private void message(String value) {
    if (isDestroyed()) return;
    if (notice != null) {
      notice.setText(value == null ? "操作未完成" : value);
      notice.setVisibility(View.VISIBLE);
    } else Toast.makeText(this, value, Toast.LENGTH_LONG).show();
  }

  private void pendingRequestBanner() {
    if (computer == null) return;
    try {
      if (store.pending(pcId()) != null) {
        LinearLayout pending = card(body);
        text(pending, "上次操作的结果尚未确认", 15, 0xffac5c27);
        text(pending, "网络可能在提交后断开。可用同一请求编号查询结果，避免重复执行。", 13, MUTED);
        button(
            pending,
            "重试原请求",
            true,
            () ->
                mutate(
                    null,
                    true,
                    result -> {
                      JSONObject task = result.optJSONObject("task");
                      if (task != null) openTask(task.optString("id"));
                      else {
                        render();
                        refresh(true);
                      }
                    }));
        button(
            pending,
            "已核对任务，清除待确认标记",
            false,
            () ->
                new AlertDialog.Builder(this)
                    .setTitle("已经核对电脑任务？")
                    .setMessage("清除标记不会撤销已执行的操作。请先在任务列表确认结果，避免重复提交。")
                    .setNegativeButton("返回", null)
                    .setPositiveButton(
                        "已核对",
                        (d, w) -> {
                          try {
                            store.pending(pcId(), null);
                            render();
                          } catch (Exception e) {
                            message(e.getMessage());
                          }
                        })
                    .show());
      }
    } catch (Exception e) {
      message(e.getMessage());
    }
  }

  private void mutate(
      JSONObject command, boolean retry, java.util.function.Consumer<JSONObject> success) {
    if (!connected() || busy) return;
    busy = true;
    String pc = pcId();
    JSONObject target = computer;
    message("正在提交…");
    hideKeyboard();
    io.execute(
        () -> {
          try {
            JSONObject result = RemoteClient.mutation(store, target, command, retry);
            main.post(
                () -> {
                  busy = false;
                  if (isDestroyed() || !pc.equals(pcId())) return;
                  message("操作已同步到电脑");
                  success.accept(result);
                });
          } catch (Exception error) {
            main.post(
                () -> {
                  busy = false;
                  if (!pc.equals(pcId())) return;
                  render();
                  message(error.getMessage());
                });
          }
        });
  }

  private void updateConnection() {
    if (connection == null) return;
    connection.setVisibility(tab.equals("首页") && taskId.isEmpty() ? View.GONE : View.VISIBLE);
    connection.setText(
        computer == null
            ? "○  尚未连接电脑"
            : (sync.has("at") ? "●  " : "○  ")
                + computer.optString("name")
                + (sync.has("at")
                    ? (sync.optBoolean("canControl") ? " · 已连接" : " · 仅查看")
                    : " · 等待连接"));
    connection.setTextColor(sync.has("at") ? BLUE : MUTED);
  }

  private void refresh(boolean requested) {
    if (computer == null || polling || isDestroyed()) return;
    polling = true;
    JSONObject target = computer;
    String pc = pcId(), id = taskId;
    int after = cursor, rev = revision;
    io.execute(
        () -> {
          try {
            JSONObject data = RemoteClient.read(target, RemoteClient.object("action", "sync"));
            JSONObject task =
                id.isEmpty()
                    ? null
                    : RemoteClient.read(
                        target,
                        RemoteClient.object(
                            "action",
                            "task.get",
                            "id",
                            id,
                            "after",
                            after,
                            "revision",
                            rev,
                            "limit",
                            100));
            main.post(
                () -> {
                  polling = false;
                  if (isDestroyed() || !pc.equals(pcId())) return;
                  sync = data;
                  JSONArray updated = data.optJSONArray("tasks");
                  if (taskList.length() <= 50 || requested) {
                    taskList = updated == null ? new JSONArray() : updated;
                    totalTasks = data.optInt("total");
                  } else {
                    for (int i = 0; updated != null && i < updated.length(); i++)
                      try {
                        taskList.put(i, updated.getJSONObject(i));
                      } catch (JSONException ignored) {
                      }
                  }
                  updateConnection();
                  updateProfiles();
                  if (modelInfo != null) modelInfo.setText("模型：" + sync.optString("model", "使用电脑当前模型"));
                  if (taskId.isEmpty()) renderTaskCards();
                  if (task != null && id.equals(taskId)) {
                    detail = task.optJSONObject("task");
                    if (task.optBoolean("reset")) events.clear();
                    JSONArray incoming = task.optJSONArray("events");
                    for (int i = 0; incoming != null && i < incoming.length(); i++) {
                      JSONObject event = incoming.optJSONObject(i);
                      events.put(event.optString("id"), event);
                    }
                    cursor = task.optInt("cursor");
                    revision = task.optInt("revision");
                    hasMore = task.optBoolean("hasMore");
                    updateDetail();
                    JSONObject stream = task.optJSONObject("stream");
                    if (streamText != null)
                      streamText.setText(
                          stream == null
                              ? ""
                              : stream.optString(
                                  "text", stream.optString("partialText", "Agent 正在思考…")));
                  }
                  if (requested && notice != null) notice.setVisibility(View.GONE);
                });
          } catch (Exception e) {
            main.post(
                () -> {
                  polling = false;
                  if (!pc.equals(pcId()) || isDestroyed()) return;
                  connection.setText("○  " + target.optString("name") + " · 暂不可达");
                  connection.setTextColor(MUTED);
                  if (requested) message("连接未完成：" + e.getMessage() + "。电脑须开机，手机须能访问电脑地址。");
                });
          }
        });
  }

  private void hideKeyboard() {
    View focus = getCurrentFocus();
    if (focus != null) {
      getSystemService(InputMethodManager.class).hideSoftInputFromWindow(focus.getWindowToken(), 0);
      focus.clearFocus();
    }
  }

  @Override
  protected void onSaveInstanceState(Bundle out) {
    saveDraft();
    out.putString("tab", tab);
    out.putString("taskId", taskId);
    super.onSaveInstanceState(out);
  }

  @Override
  protected void onResume() {
    super.onResume();
    if (store.statusEnabled()) {
      try { startForegroundService(new Intent(this, StatusSyncService.class)); }
      catch (Exception error) { message("状态同步未恢复，请在设备页重新开启"); }
    }
    main.removeCallbacks(localTick);
    main.post(localTick);
    main.removeCallbacks(tick);
    main.post(tick);
    if (computer != null && store.notifications() && !RemoteSyncService.running)
      try {
        startForegroundService(new Intent(this, RemoteSyncService.class));
      } catch (Exception error) {
        message("后台连接未恢复：" + error.getMessage());
      }
  }

  @Override
  protected void onPause() {
    main.removeCallbacks(localTick);
    main.removeCallbacks(tick);
    saveDraft();
    super.onPause();
  }

  @Override
  protected void onDestroy() {
    main.removeCallbacks(localTick);
    main.removeCallbacks(tick);
    io.shutdownNow();
    super.onDestroy();
  }

}
