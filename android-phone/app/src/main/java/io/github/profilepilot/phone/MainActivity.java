package io.github.profilepilot.phone;

import android.Manifest;
import android.app.AlertDialog;
import android.app.Dialog;
import android.app.NotificationManager;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityNodeInfo;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import androidx.activity.ComponentActivity;
import androidx.activity.result.ActivityResultLauncher;
import com.journeyapps.barcodescanner.ScanContract;
import com.journeyapps.barcodescanner.ScanOptions;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

/** One home for real connection status, permission preparation and local control authority. */
public final class MainActivity extends ComponentActivity {
  private static int visibleHomes;
  static boolean isHomeVisible() { return visibleHomes>0; }
  private static final int INK=0xff1c2926, MUTED=0xff738178, BG=0xfff7f9f7,
      LINE=0xffe5ece7, GREEN=0xff11775d, MINT=0xffedf7f1,
      BLUE=0xff356cd7, SOFT_BLUE=0xffeef3ff, AMBER=0xff956423, RED=0xffb64646;
  private final Handler main=new Handler(Looper.getMainLooper());
  private final ExecutorService io=Executors.newSingleThreadExecutor();
  private ComputerStore store;
  private LinearLayout hero, computerRow, sessionActions, permissionRows, permissionSummary;
  private TextView title, description, badge, computerName, computerTransport, pause, stop,
      permissionCount, permissionSummaryAction, permissionHint, reassurance, serviceError;
  private HomeIcon computerGraphic, phoneGraphic, linkGraphic;
  private final SettingRow[] permissions=new SettingRow[3];
  private SettingRow developer, recoveryRow;
  private DebugOption wifi, usb;
  private boolean permissionsExpanded, seenConnected;
  private int lastPermissionCount=-1;
  private PhoneHomeState lastState;
  private Dialog sheet;
  private final Runnable tick=new Runnable() {
    @Override public void run() { updateHome(); main.postDelayed(this,1000); }
  };
  private final ActivityResultLauncher<ScanOptions> scanner=registerForActivityResult(
      new ScanContract(), result -> { if (result.getContents()!=null) pairStatus(result.getContents()); });

  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    store=new ComputerStore(this);
    if (state!=null) {
      permissionsExpanded=state.getBoolean("permissionsExpanded");
      lastPermissionCount=state.getInt("lastPermissionCount",-1);
      seenConnected=state.getBoolean("seenConnected");
    }
    getWindow().setStatusBarColor(BG); getWindow().setNavigationBarColor(BG);
    getWindow().getDecorView().setSystemUiVisibility(
        View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
    // Retire task notifications without touching control or status-sync channels or saved credentials.
    store.notifications(false);
    NotificationManager notifications=getSystemService(NotificationManager.class);
    notifications.deleteNotificationChannel("mobile-tasks");
    notifications.deleteNotificationChannel("mobile-connection");
    renderHome(); consumeIntent();
  }

  @Override protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent); setIntent(intent); consumeIntent(); updateHome();
  }

  private SharedPreferences pairing() { return getSharedPreferences("MainActivity",MODE_PRIVATE); }

  private void consumeIntent() {
    Intent intent=getIntent();
    String token=intent.getStringExtra("token"), computer=intent.getStringExtra("computer");
    intent.removeExtra("token"); intent.removeExtra("computer");
    // Android protects this component with DUMP; ordinary apps and browser links
    // enter through LauncherActivity and must never be able to replace a computer.
    boolean debuggingEntry=intent.getComponent()!=null
        && getPackageName().equals(intent.getComponent().getPackageName())
        && MainActivity.class.getName().equals(intent.getComponent().getClassName());
    if (debuggingEntry && token!=null && token.matches("[a-f0-9]{64}") && computer!=null
        && !computer.isBlank() && computer.length()<=120) {
      connectComputer(token,computer);
    }
    // Old notifications and explicit share intents can outlive an upgrade. They never open a task.
    intent.removeExtra("computerId"); intent.removeExtra("taskId");
    if (Intent.ACTION_SEND.equals(intent.getAction())) {
      intent.setAction(null); intent.removeExtra(Intent.EXTRA_TEXT);
      message("请在电脑端使用任务功能。");
    }
    Uri data=intent.getData(); intent.setData(null);
    if (data!=null && "profilepilot".equals(data.getScheme())) {
      if ("status".equals(data.getHost())) pairStatus(data.toString());
      else if ("pair".equals(data.getHost()) || "task".equals(data.getHost()))
        message("手机端仅提供连接与权限准备，请在电脑端使用任务功能。");
    }
    if (intent.getBooleanExtra("wirelessGuide",false)) {
      intent.removeExtra("wirelessGuide");
      showConnectionSettings(true);
    }
  }

  private void renderHome() {
    LinearLayout root=column(); root.setBackgroundColor(BG);
    root.setOnApplyWindowInsetsListener((view,insets) -> {
      android.graphics.Insets bars=insets.getInsets(WindowInsets.Type.systemBars());
      view.setPadding(bars.left,bars.top,bars.right,bars.bottom); return insets;
    });
    LinearLayout toolbar=row(); toolbar.setPadding(dp(22),dp(8),dp(12),dp(8));
    root.addView(toolbar,new LinearLayout.LayoutParams(-1,dp(64)));
    toolbar.addView(icon("brand",GREEN,28));
    TextView brand=text(toolbar,BuildConfig.DEBUG ? "ProfilePilot 开发版" : "ProfilePilot",20,INK,true);
    LinearLayout.LayoutParams brandParams=new LinearLayout.LayoutParams(0,-2,1);
    brandParams.setMarginStart(dp(10)); brand.setLayoutParams(brandParams);
    View more=iconButton("more","更多选项",this::showMore); more.setId(R.id.home_more); toolbar.addView(more);
    ScrollView scroll=new ScrollView(this); scroll.setId(R.id.home_scroll);
    scroll.setFillViewport(true); scroll.setClipToPadding(false); scroll.setVerticalScrollBarEnabled(false);
    LinearLayout page=column(); page.setPadding(dp(20),dp(8),dp(20),dp(28));
    scroll.addView(page); root.addView(scroll,new LinearLayout.LayoutParams(-1,0,1)); setContentView(root);

    hero=card(page,22); hero.setPadding(dp(18),dp(18),dp(18),dp(18));
    LinearLayout heroTop=row(); hero.addView(heroTop);
    TextView phoneLabel=text(heroTop,"这台手机",12,MUTED,false); weight(phoneLabel);
    badge=text(heroTop,"",11,MUTED,false); badge.setPadding(dp(9),dp(5),dp(9),dp(5));
    LinearLayout illustration=row(); illustration.setGravity(Gravity.CENTER);
    hero.addView(illustration,new LinearLayout.LayoutParams(-1,dp(72)));
    computerGraphic=icon("computer",MUTED,38); illustration.addView(computerGraphic);
    View firstLine=new View(this); firstLine.setBackgroundColor(0xffc5dacf);
    LinearLayout.LayoutParams lineParams=new LinearLayout.LayoutParams(dp(23),dp(1));
    lineParams.setMargins(dp(12),0,dp(5),0); illustration.addView(firstLine,lineParams);
    linkGraphic=icon("check",MUTED,18); illustration.addView(linkGraphic);
    View secondLine=new View(this); secondLine.setBackgroundColor(0xffc5dacf);
    LinearLayout.LayoutParams secondParams=new LinearLayout.LayoutParams(dp(23),dp(1));
    secondParams.setMargins(dp(5),0,dp(12),0); illustration.addView(secondLine,secondParams);
    phoneGraphic=icon("phone",MUTED,32); illustration.addView(phoneGraphic);
    title=text(hero,"",25,INK,true); title.setId(R.id.home_status); title.setGravity(Gravity.CENTER);
    title.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
    description=text(hero,"",12,MUTED,false); description.setGravity(Gravity.CENTER); description.setPadding(0,dp(6),0,0);
    computerRow=row(); computerRow.setId(R.id.home_computer);
    LinearLayout.LayoutParams computerParams=new LinearLayout.LayoutParams(-1,-2);
    computerParams.topMargin=dp(18); hero.addView(computerRow,computerParams); computerRow.setPadding(dp(2),dp(12),dp(2),0);
    computerRow.addView(icon("computer",GREEN,28));
    LinearLayout computerCopy=column(); LinearLayout.LayoutParams copyParams=new LinearLayout.LayoutParams(0,-2,1);
    copyParams.setMarginStart(dp(12)); computerRow.addView(computerCopy,copyParams);
    computerName=text(computerCopy,"",14,INK,true); computerTransport=text(computerCopy,"",12,MUTED,false);
    computerTransport.setPadding(0,dp(4),0,0); computerRow.addView(icon("chevron",MUTED,16));
    clickable(computerRow,"电脑连接详情",this::showConnectionDetails);
    sessionActions=row(); LinearLayout.LayoutParams actionsParams=new LinearLayout.LayoutParams(-1,-2);
    actionsParams.topMargin=dp(16); hero.addView(sessionActions,actionsParams);
    pause=button(sessionActions,"暂停控制",true,null); pause.setId(R.id.home_pause);
    LinearLayout.LayoutParams pauseParams=new LinearLayout.LayoutParams(0,dp(48),1);
    pauseParams.setMarginEnd(dp(8)); pause.setLayoutParams(pauseParams);
    stop=button(sessionActions,"结束控制",false,null); stop.setId(R.id.home_stop);
    stop.setLayoutParams(new LinearLayout.LayoutParams(0,dp(48),1)); stop.setTextColor(RED); stop.setBackground(ripple(Color.WHITE,11,true));
    serviceError=text(page,"",12,RED,false); serviceError.setVisibility(View.GONE);

    permissionCount=heading(page,"权限准备","");
    LinearLayout permissionCard=card(page,17); permissionCard.setId(R.id.home_permissions);
    permissionSummary=row(); permissionSummary.setId(R.id.home_permission_summary); permissionSummary.setPadding(dp(14),dp(16),dp(12),dp(16));
    permissionSummary.addView(icon("shield",GREEN,28));
    LinearLayout summaryCopy=column(); LinearLayout.LayoutParams summaryParams=new LinearLayout.LayoutParams(0,-2,1);
    summaryParams.setMarginStart(dp(10)); permissionSummary.addView(summaryCopy,summaryParams);
    text(summaryCopy,"连接与控制所需权限已就绪",13,INK,true);
    TextView summaryHint=text(summaryCopy,"无障碍服务 · 悬浮提示 · 通知",11,MUTED,false); summaryHint.setPadding(0,dp(5),0,0);
    permissionSummaryAction=text(permissionSummary,"查看",11,GREEN,false);
    clickable(permissionSummary,"查看已开启的权限",() -> { permissionsExpanded=!permissionsExpanded; updateHome(); }); permissionCard.addView(permissionSummary);
    permissionRows=column(); permissionCard.addView(permissionRows);
    permissions[0]=setting(permissionRows,"accessibility","无障碍服务","读取屏幕、点击与输入",R.id.home_accessibility,
        () -> launchSetting(() -> PhoneSettings.openAccessibility(this)));
    permissions[1]=setting(permissionRows,"overlay","悬浮提示","在其他应用上显示控制状态",R.id.home_overlay,
        () -> launchSetting(() -> PhoneSettings.openOverlayPermission(this)));
    permissions[2]=setting(permissionRows,"bell","状态通知","在通知栏随时暂停控制",R.id.home_notifications,this::openNotifications);
    developer=setting(permissionCard,"phone","开发者选项","USB / Wi-Fi 调试的前置设置",R.id.home_developer,
        () -> launchSetting(() -> PhoneSettings.openDeveloperOptions(this)));
    permissionHint=text(page,"开启无障碍后，可辅助配置其余设置。",11,MUTED,false); permissionHint.setPadding(dp(3),dp(8),dp(3),0);

    heading(page,"连接设置","任选一种即可");
    LinearLayout connectionCard=card(page,17);
    LinearLayout connectionOptions=row(); connectionCard.addView(connectionOptions,new LinearLayout.LayoutParams(-1,-2));
    wifi=new DebugOption("wifi","Wi-Fi 无线调试","手机与电脑\n在同一局域网",R.id.home_wifi,() -> showConnectionSettings(true));
    usb=new DebugOption("usb","USB 调试","通过数据线\n连接电脑",R.id.home_usb,() -> showConnectionSettings(false));
    connectionOptions.addView(wifi.view,new LinearLayout.LayoutParams(0,-1,1));
    View connectionDivider=new View(this); connectionDivider.setBackgroundColor(LINE);
    LinearLayout.LayoutParams dividerParams=new LinearLayout.LayoutParams(dp(1),-1);
    dividerParams.setMargins(0,dp(14),0,dp(14)); connectionOptions.addView(connectionDivider,dividerParams);
    connectionOptions.addView(usb.view,new LinearLayout.LayoutParams(0,-1,1));
    recoveryRow=setting(connectionCard,"shield","自动恢复","后台连接服务与已授权的系统服务",R.id.home_recovery,this::showRecovery);
    TextView connectionHint=text(page,"先开启开发者选项，再任选一种调试方式。",11,MUTED,false); connectionHint.setPadding(dp(3),dp(8),dp(3),0);
    reassurance=text(page,"",12,MUTED,false); reassurance.setGravity(Gravity.CENTER); reassurance.setPadding(0,dp(24),0,dp(8));
    TextView help=button(page,"连接遇到问题？",false,this::showHelp); help.setTextSize(12); help.setTextColor(MUTED); help.setBackground(ripple(BG,10,false));
    LinearLayout.LayoutParams helpParams=new LinearLayout.LayoutParams(-1,dp(48)); helpParams.topMargin=dp(6); help.setLayoutParams(helpParams);
    updateHome();
  }

  private void updateHome() {
    if (title==null || isDestroyed()) return;
    ControlService service=ControlService.current; SessionState session=service==null?null:service.session;
    if (session!=null) session.expire();
    PhoneReadiness ready=new PhoneReadiness(this);
    boolean all=ready.overlay && ready.notifications && ready.accessibilityService.equals("running");
    PhoneHomeState state=PhoneHomeState.from(new PhoneHomeState.Input(ready.computerConnected,
        ready.usbDebugging.equals("enabled") || ready.wirelessDebugging.equals("enabled"),all,ready.unlocked,
        seenConnected,session!=null && session.sessionId!=null,session==null?"idle":session.phase,session==null?"view":session.mode));
    seenConnected|=ready.computerConnected;
    if (!state.equals(lastState)) {
      setText(title,state.title()); setText(description,state.description()); setText(badge,"●  "+state.badge());
      int accent=switch(state.tone()) { case CONNECTED -> GREEN; case ACTIVE -> BLUE; case ATTENTION -> AMBER; default -> MUTED; };
      int surface=switch(state.tone()) { case CONNECTED -> MINT; case ACTIVE -> SOFT_BLUE; case ATTENTION -> 0xfffcf5e9; default -> Color.WHITE; };
      int tint=switch(state.tone()) { case CONNECTED -> 0xffdceee3; case ACTIVE -> 0xffdfe8fe; case ATTENTION -> 0xfff7e9ce; default -> 0xffeff2f0; };
      hero.setBackground(background(surface,22,true)); badge.setTextColor(accent); badge.setBackground(background(tint,20,false));
      computerGraphic.color(accent); phoneGraphic.color(accent); linkGraphic.color(accent);
      sessionActions.setVisibility(state.controls()?View.VISIBLE:View.GONE);
      setText(pause,(state.paused()?"继续":"暂停")+(state.viewing()?"查看":"控制")); pause.setContentDescription(pause.getText());
      pause.setBackground(ripple(state.paused()?GREEN:BLUE,11,false));
      setText(stop,"结束"+(state.viewing()?"查看":"控制")); stop.setContentDescription(stop.getText()); lastState=state;
    }
    linkGraphic.setVisibility(ready.computerConnected?View.VISIBLE:View.INVISIBLE);
    String trustedName=pairing().getString("computer",""); boolean paired=!pairing().getString("token","").isEmpty();
    computerRow.setVisibility(paired || ready.computerConnected?View.VISIBLE:View.GONE);
    setText(computerName,(ready.computerConnected?"":"上次连接：")+(trustedName.isBlank()?"电脑":trustedName));
    String owner=state.controls() && session!=null && !session.controller.isBlank()?" · "+session.controller:"";
    setText(computerTransport,ready.computerConnected?transportLabel(ready)+owner:"当前未连接");
    computerRow.setContentDescription(computerName.getText()+"，"+computerTransport.getText()+"，查看连接详情");
    if (service!=null && state.controls()) {
      Runnable toggle=service.pauseOrResumeAction(), end=service.sessionControlAction("stop");
      pause.setOnClickListener(view -> { toggle.run(); updateHome(); }); stop.setOnClickListener(view -> { end.run(); updateHome(); });
    }
    boolean[] enabled={ready.accessibilityService.equals("running"),ready.overlay,ready.notifications}; int count=0;
    for (int i=0;i<3;i++) {
      if (enabled[i]) count++;
      permissions[i].status(enabled[i]?"已开启":i==0 && !ready.accessibilityService.equals("disabled")?"去检查":"去开启",GREEN);
      permissions[i].icon.color(enabled[i]?0xff7c9284:GREEN);
    }
    setText(permissions[0].detail,switch(ready.accessibilityService) {
      case "enabled" -> "已开启，但服务没有运行"; case "unknown" -> "暂时无法确认服务状态"; default -> "读取屏幕、点击与输入";
    });
    if (count==3 && lastPermissionCount>=0 && lastPermissionCount!=3) permissionsExpanded=false;
    lastPermissionCount=count; int pending=3-count+(ready.developerOptions.equals("enabled")?0:1);
    setText(permissionCount,pending==0?"全部已就绪":"还需处理 "+pending+" 项");
    permissionCount.setTextColor(pending==0?GREEN:MUTED); permissionSummary.setVisibility(count==3?View.VISIBLE:View.GONE);
    permissionRows.setVisibility(count<3 || permissionsExpanded?View.VISIBLE:View.GONE); permissionHint.setVisibility(count<3?View.VISIBLE:View.GONE);
    setText(permissionSummaryAction,permissionsExpanded?"收起":"查看"); permissionSummary.setContentDescription(permissionsExpanded?"收起已开启的权限":"查看已开启的权限");
    developer.status(ready.debugLabel("developerOptions"),debugStateColor(ready.developerOptions));
    boolean anyDebug=ready.usbDebugging.equals("enabled") || ready.wirelessDebugging.equals("enabled");
    updateDebugOption(wifi,ready.wifiConnected,ready.wirelessDebugging,ready.debugLabel("wirelessDebugging"),anyDebug);
    updateDebugOption(usb,ready.usbConnected,ready.usbDebugging,ready.debugLabel("usbDebugging"),anyDebug);
    RecoverySettings recovery=new RecoverySettings(this);
    recoveryRow.status(recovery.enabled()?"已开启":"未开启",recovery.enabled()?GREEN:MUTED);
    setText(reassurance,state.controls()?"手机的控制权始终在你手中。\n锁屏或连接中断时，会停止操作。"
        :ready.computerConnected?(all?"手机准备好了。\n需要使用时，在电脑上开始。":"完成权限准备后，即可由电脑使用。") : "");
    reassurance.setVisibility(ready.computerConnected?View.VISIBLE:View.GONE);
  }

  private void updateDebugOption(DebugOption option,boolean connected,String state,String label,boolean anyDebug) {
    String value=connected?"当前使用":state.equals("enabled")?"已开启":state.equals("disabled")?"未开启":"待确认";
    option.status(value,connected || state.equals("enabled")?GREEN:state.equals("disabled") && anyDebug?MUTED:AMBER);
    option.view.setContentDescription(option.name.getText()+"，"+(connected?"当前使用":label)+"，查看设置");
  }
  private String transportLabel(PhoneReadiness ready) {
    if (ready.usbConnected && ready.wifiConnected) return "USB 与 Wi-Fi 连接在线";
    if (ready.usbConnected) return "USB 连接"; if (ready.wifiConnected) return "Wi-Fi 连接";
    ControlService service=ControlService.current;
    return service!=null && service.connection.connected("emulator")?"模拟器连接":ready.computerConnected?"电脑连接在线":"未连接";
  }
  private void ensureControlService() {
    if (ControlService.current!=null || !pairing().getString("token","").matches("[a-f0-9]{64}")) return;
    try { startForegroundService(new Intent(this,ControlService.class)); serviceError.setVisibility(View.GONE); }
    catch (RuntimeException error) {
      setText(serviceError,"连接服务暂未启动，请重新打开 App 或查看连接帮助。"); serviceError.setVisibility(View.VISIBLE);
    }
  }

  private void connectComputer(String token,String computer) {
    if (token.equals(pairing().getString("token","")) && computer.equals(pairing().getString("computer",""))) {
      ensureControlService(); return;
    }
    ControlService service=ControlService.current;
    if (service!=null && !service.session.phase.equals("idle") && !service.session.phase.equals("stopped")) {
      message("请先结束当前控制会话，再连接另一台电脑。"); return;
    }
    if (service!=null) stopService(new Intent(this,ControlService.class));
    pairing().edit().putString("token",token).putString("computer",computer).apply();
    seenConnected=false; dismissSheet();
    try { startForegroundService(new Intent(this,ControlService.class)); }
    catch (RuntimeException error) { message("连接服务暂未启动，请重新打开 App。"); }
    updateHome();
  }

  private void showConnectionSettings(boolean wireless) {
    PhoneReadiness ready=new PhoneReadiness(this); String name=wireless?"Wi-Fi 无线调试":"USB 调试";
    String key=wireless?"wirelessDebugging":"usbDebugging";
    String state=wireless?ready.wirelessDebugging:ready.usbDebugging;
    boolean enabled=state.equals("enabled");
    LinearLayout content=showSheet(name);
    paragraph(content,"USB 和 Wi-Fi 任选一种即可。完成调试设置与必要授权后，电脑会自动连接。");
    info(content,name,ready.debugLabel(key),debugStateColor(state));
    if (wireless) {
      paragraph(content,"1  手机和电脑处于同一局域网，电脑端 ProfilePilot 保持运行。\n\n2  开启无线调试，按系统提示允许当前网络。\n\n3  首次使用时，按电脑提示完成系统配对；之后由电脑自动连接。");
    } else paragraph(content,"1  使用支持数据传输的 USB 线连接电脑。\n\n2  开启 USB 调试，手机弹出授权时允许你的电脑。\n\n3  电脑端 ProfilePilot 运行时会自动连接，首页会自动更新。");
    if (PhoneAccessibility.current!=null && !enabled) paragraph(content,"可辅助打开开关，系统确认由你完成。");
    actionButton(content,enabled?"查看系统设置":PhoneAccessibility.current!=null?"辅助开启调试":"前往开启调试",true,
        () -> launchSetting(() -> { if (wireless) PhoneSettings.openWirelessDebugging(this); else PhoneSettings.openUsbDebugging(this); }));
  }
  private void showMore() {
    LinearLayout content=showSheet("更多");
    menuItem(content,"检查更新",() -> { dismissSheet(); startActivity(new Intent(this,UpdateActivity.class)); });
    menuItem(content,"电脑连接详情",this::showConnectionDetails); menuItem(content,"手机状态同步",this::showStatusSync); menuItem(content,"自动恢复",this::showRecovery); menuItem(content,"连接帮助",this::showHelp);
    if (!pairing().getString("token","").isEmpty()) menuItem(content,"更换电脑",this::confirmForget);
    paragraph(content,getString(R.string.app_name)+" · 手机连接助手\n版本 "+BuildConfig.VERSION_NAME).setTextSize(11);
  }
  private void showConnectionDetails() {
    PhoneReadiness ready=new PhoneReadiness(this); LinearLayout content=showSheet("电脑连接详情");
    String computer=pairing().getString("computer","");
    info(content,ready.computerConnected?"当前电脑":"上次授权电脑",computer.isBlank()?"尚未授权":computer);
    info(content,"当前连接",transportLabel(ready)); info(content,"控制状态",lastState==null?"未在控制":lastState.title());
    info(content,"手机屏幕",ready.unlocked?"已解锁":"已锁屏");
    paragraph(content,ready.computerConnected?"已检测到电脑的实际连接。":"开启调试并完成必要授权后，电脑会自动连接。已配对或状态同步在线，不代表电脑当前已连接。");
    if (!computer.isBlank()) actionButton(content,"更换电脑",false,this::confirmForget).setTextColor(RED);
  }
  private void confirmForget() {
    LinearLayout content=showSheet("更换连接的电脑？");
    paragraph(content,"将结束当前控制，清除电脑连接记录，并停止状态同步。之后可在电脑端重新连接。已开启的手机权限会保留。");
    actionButton(content,"结束连接并更换",true,() -> {
      RecoverySettings recovery=new RecoverySettings(this); recovery.enabled(false); recovery.advanced(false);
      ControlService service=ControlService.current; if (service!=null) service.localControl("stop");
      stopService(new Intent(this,ControlService.class)); pairing().edit().remove("token").remove("computer").apply();
      store.statusEnabled(false); stopService(new Intent(this,StatusSyncService.class));
      seenConnected=false; dismissSheet(); main.postDelayed(this::updateHome,150);
    }).setBackground(ripple(RED,11,false));
    actionButton(content,"暂不更换",false,this::dismissSheet);
  }
  private void showRecovery() {
    RecoverySettings recovery=new RecoverySettings(this);
    LinearLayout content=showSheet("自动恢复");
    paragraph(content,"开启后，系统回收、手机重启或 App 更新后会尝试恢复后台连接服务。恢复连接不会继续旧控制会话，也不会重放操作。");
    actionButton(content,recovery.enabled()?"关闭自动恢复":"开启自动恢复",true,() -> {
      recovery.enabled(!recovery.enabled()); refreshRecoveryServices(); showRecovery();
    }).setId(R.id.recovery_toggle);
    info(content,"高级恢复授权",recovery.authorized()?"已授权":"未授权",recovery.authorized()?GREEN:AMBER);
    paragraph(content,"高级恢复可重启权限仍开启但未运行的无障碍服务，并在观察到 Wi-Fi 断开重连后尝试恢复无线调试。每项最多尝试 3 次 / 30 分钟，无持续唤醒。");
    paragraph(content,"无障碍权限已关闭、无线调试在网络稳定时被关闭，都会保留关闭状态。若在断网期间手动关闭调试，请同时关闭自动恢复。新网络的系统授权仍需你确认。");
    if (!recovery.authorized()) paragraph(content,"高级恢复需要已授权电脑额外授予系统设置权限；未授权时仍可使用后台服务恢复。");
    TextView advanced=actionButton(content,recovery.advanced()?"关闭高级恢复":"开启高级恢复",false,() -> {
      recovery.advanced(!recovery.advanced()); refreshRecoveryServices(); showRecovery();
    }); advanced.setId(R.id.recovery_advanced); advanced.setEnabled(recovery.enabled()); advanced.setAlpha(recovery.enabled()?1f:0.45f);
    info(content,"最近一次结果",recovery.lastResult());
    if (recovery.lastResultAt()>0) paragraph(content,java.text.DateFormat.getDateTimeInstance().format(new java.util.Date(recovery.lastResultAt()))).setTextSize(11);
    paragraph(content,"系统“强行停止”、厂商禁止后台运行或调试授权被撤销后，App 不能保证自行恢复。请允许 ProfilePilot 后台运行；无需关闭整台手机的省电功能。");
    actionButton(content,"查看应用后台设置",false,() -> launchSetting(() -> startActivity(new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,Uri.parse("package:"+getPackageName())))));
    actionButton(content,"刷新状态",false,this::showRecovery);
  }
  private void refreshRecoveryServices() {
    try {
      if (new RecoverySettings(this).paired()) startForegroundService(new Intent(this,ControlService.class));
      if (store.statusEnabled()) startForegroundService(new Intent(this,StatusSyncService.class));
    } catch (RuntimeException unavailable) { new RecoverySettings(this).record("请保持 App 打开，稍后重新尝试启动连接服务"); }
    updateHome();
  }
  private void showHelp() {
    LinearLayout content=showSheet("连接遇到问题？"); text(content,"先检查手机",15,INK,true);
    paragraph(content,"保持解锁；电脑端 ProfilePilot 保持运行；确认 USB 调试或 Wi-Fi 无线调试已开启。通过系统调试授权的电脑可直接连接，无需在 App 内再次确认。");
    text(content,"USB 连接",15,INK,true);
    paragraph(content,"检查数据线是否支持数据传输，并确认手机上的调试授权。Windows 电脑还可能需要手机厂商的 ADB 驱动；macOS 通常无需单独安装驱动。");
    text(content,"Wi-Fi 连接",15,INK,true);
    paragraph(content,"确保处于同一局域网，无线调试保持开启；电脑接同一路由器的网线也可以。首次按电脑提示完成系统配对，更换网络后等待电脑重新发现并连接。");
    text(content,"权限提示",15,INK,true);
    paragraph(content,"无障碍服务已开启但未运行时，可到系统设置重新开启。系统无法提供开关状态时，会显示待确认，可点击设置项手动核对。");
    paragraph(content,"自动恢复连接不会自动继续控制。需要在电脑重新开始，或在有效的暂停会话中手动继续。");
  }

  private void showStatusSync() {
    io.execute(() -> {
      JSONObject link=null; try { link=store.statusLink(false); } catch (Exception ignored) { }
      JSONObject saved=link;
      postAlive(() -> {
        LinearLayout content=showSheet("手机状态同步");
        paragraph(content,"同步权限、锁屏、调试开关和当前 Wi-Fi 地址，帮助已绑定的电脑自动发现手机。不上传屏幕或控制凭据。");
        paragraph(content,"状态同步无需同一 Wi-Fi；无线控制仍需同一局域网并完成配对。同步在线不代表电脑已连接。");
        if (saved!=null) {
          info(content,"服务器",saved.optString("url")); info(content,"同步状态",store.statusEnabled()?StatusSyncService.message:"已停止同步");
          boolean enabled=store.statusEnabled();
          actionButton(content,enabled?"停止状态同步":"开启状态同步",!enabled,() -> {
            store.statusEnabled(!enabled); if (enabled) stopService(new Intent(this,StatusSyncService.class)); else startStatusSync(); dismissSheet();
          });
        } else paragraph(content,"在电脑「手机」页面打开状态同步，扫描生成的二维码或粘贴状态同步链接。");
        actionButton(content,"扫描状态同步二维码",false,() -> {
          dismissSheet(); scanner.launch(new ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE)
              .setPrompt("扫描电脑上的状态同步二维码").setBeepEnabled(false).setOrientationLocked(false));
        });
        actionButton(content,"粘贴状态同步链接",false,this::pasteStatusLink);
      });
    });
  }
  private void pasteStatusLink() {
    dismissSheet(); EditText input=new EditText(this); input.setHint(BuildConfig.PAIRING_SCHEME+"://status…");
    input.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_URI); input.setMaxLines(4);
    new AlertDialog.Builder(this).setTitle("状态同步链接").setView(input).setNegativeButton("取消",null)
        .setPositiveButton("继续",(dialog,which) -> pairStatus(input.getText().toString())).show();
  }
  private void pairStatus(String value) {
    try {
      JSONObject target=StatusSyncClient.parse(value); LinearLayout content=showSheet("开启手机状态同步？");
      paragraph(content,"向以下服务器上报权限、锁屏、调试开关及当前 Wi-Fi 地址和发现的无线调试端口，帮助已绑定的电脑自动连接。不上传屏幕或控制凭据。");
      paragraph(content,target.getString("url")); paragraph(content,"可在「更多 → 手机状态同步」或通知栏停止同步。");
      actionButton(content,"开启同步",true,() -> {
        dismissSheet(); io.execute(() -> {
          try { StatusSyncClient.pair(this,target); postAlive(() -> { startStatusSync(); message("手机状态同步已开启。"); }); }
          catch (Exception error) { postAlive(() -> message("状态同步配对失败，请检查网络或重新扫码。")); }
        });
      });
    } catch (Exception error) { message("请使用电脑生成的手机状态同步链接。"); }
  }
  private void startStatusSync() {
    try { startForegroundService(new Intent(this,StatusSyncService.class)); }
    catch (RuntimeException error) { message("状态同步暂未启动，可在更多选项中重新开启。"); }
  }
  private void openNotifications() {
    dismissSheet();
    if (Build.VERSION.SDK_INT>=33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED
        && (!pairing().getBoolean("notificationRequested",false) || shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS))) {
      pairing().edit().putBoolean("notificationRequested",true).apply();
      requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS},1);
    }
    else launchSetting(() -> startActivity(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE,getPackageName())));
  }
  private void launchSetting(Runnable action) {
    dismissSheet(); try { action.run(); } catch (RuntimeException error) { message("无法打开该设置，请在系统设置中手动检查。"); }
  }

  private LinearLayout showSheet(String heading) {
    dismissSheet(); Dialog dialog=new Dialog(this); dialog.requestWindowFeature(Window.FEATURE_NO_TITLE);
    LinearLayout panel=column(); panel.setPadding(dp(22),dp(8),dp(22),dp(18));
    GradientDrawable surface=background(Color.WHITE,0,false); float radius=dp(24);
    surface.setCornerRadii(new float[] {radius,radius,radius,radius,0,0,0,0}); panel.setBackground(surface);
    View handle=new View(this); handle.setBackground(background(0xffdce3de,4,false));
    LinearLayout.LayoutParams handleParams=new LinearLayout.LayoutParams(dp(32),dp(4));
    handleParams.gravity=Gravity.CENTER_HORIZONTAL; handleParams.bottomMargin=dp(10); panel.addView(handle,handleParams);
    LinearLayout top=row(); panel.addView(top); TextView sheetTitle=text(top,heading,20,INK,true); weight(sheetTitle);
    View close=iconButton("close","关闭面板",this::dismissSheet); close.setId(R.id.sheet_close); top.addView(close);
    ScrollView scroll=new ScrollView(this) {
      @Override protected void onMeasure(int widthSpec,int heightSpec) {
        int maximum=(int)(getResources().getDisplayMetrics().heightPixels*.7f);
        super.onMeasure(widthSpec,View.MeasureSpec.makeMeasureSpec(maximum,View.MeasureSpec.AT_MOST));
      }
    };
    LinearLayout content=column(); content.setPadding(0,dp(8),0,dp(12)); scroll.addView(content); panel.addView(scroll);
    dialog.setContentView(panel); dialog.setCanceledOnTouchOutside(true); sheet=dialog;
    Window window=dialog.getWindow();
    if (window!=null) {
      window.setBackgroundDrawableResource(android.R.color.transparent); window.setGravity(Gravity.BOTTOM);
      window.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND); window.setDimAmount(.28f); window.setNavigationBarColor(Color.WHITE);
    }
    dialog.show(); if (window!=null) window.setLayout(-1,-2); return content;
  }

  private void dismissSheet() { if (sheet!=null) { Dialog current=sheet; sheet=null; current.dismiss(); } }
  private void postAlive(Runnable action) { main.post(() -> { if (!isFinishing() && !isDestroyed()) action.run(); }); }
  private void message(String value) { Toast.makeText(this,value,Toast.LENGTH_LONG).show(); }
  private int dp(int value) { return Math.round(value*getResources().getDisplayMetrics().density); }
  private LinearLayout column() { LinearLayout view=new LinearLayout(this); view.setOrientation(LinearLayout.VERTICAL); return view; }
  private LinearLayout row() { LinearLayout view=new LinearLayout(this); view.setOrientation(LinearLayout.HORIZONTAL); view.setGravity(Gravity.CENTER_VERTICAL); return view; }
  private void weight(View view) { view.setLayoutParams(new LinearLayout.LayoutParams(0,-2,1)); }
  private HomeIcon icon(String name,int color,int size) { HomeIcon icon=new HomeIcon(this,name,color); icon.setLayoutParams(new LinearLayout.LayoutParams(dp(size),dp(size))); return icon; }
  private GradientDrawable background(int color,int radius,boolean border) {
    GradientDrawable drawable=new GradientDrawable(); drawable.setColor(color); drawable.setCornerRadius(dp(radius));
    if (border) drawable.setStroke(dp(1),LINE); return drawable;
  }
  private RippleDrawable ripple(int color,int radius,boolean border) {
    return new RippleDrawable(ColorStateList.valueOf(0x1811775d),background(color,radius,border),background(Color.WHITE,radius,false));
  }
  private LinearLayout card(LinearLayout parent,int radius) {
    LinearLayout card=column(); card.setBackground(background(Color.WHITE,radius,true)); card.setClipToOutline(true);
    parent.addView(card,new LinearLayout.LayoutParams(-1,-2)); return card;
  }
  private TextView text(LinearLayout parent,String value,int size,int color,boolean bold) {
    TextView text=new TextView(this); text.setText(value); text.setTextSize(size); text.setTextColor(color);
    text.setIncludeFontPadding(false); text.setLineSpacing(dp(3),1); if (bold) text.setTypeface(null,Typeface.BOLD);
    parent.addView(text,new LinearLayout.LayoutParams(parent.getOrientation()==LinearLayout.HORIZONTAL?-2:-1,-2)); return text;
  }
  private TextView heading(LinearLayout parent,String title,String suffix) {
    LinearLayout row=row(); LinearLayout.LayoutParams params=new LinearLayout.LayoutParams(-1,-2);
    params.topMargin=dp(24); params.bottomMargin=dp(12); parent.addView(row,params);
    TextView name=text(row,title,16,INK,true); weight(name); return text(row,suffix,11,MUTED,false);
  }
  private TextView paragraph(LinearLayout parent,String value) {
    TextView text=text(parent,value,13,MUTED,false); text.setLineSpacing(dp(5),1); text.setPadding(0,dp(8),0,dp(14)); return text;
  }
  private void clickable(View view,String description,Runnable action) {
    view.setFocusable(true); view.setContentDescription(description); view.setOnClickListener(v -> action.run());
    view.setAccessibilityDelegate(new View.AccessibilityDelegate() {
      @Override public void onInitializeAccessibilityNodeInfo(View host,AccessibilityNodeInfo info) {
        super.onInitializeAccessibilityNodeInfo(host,info); info.setClassName(Button.class.getName());
      }
    });
  }
  private View iconButton(String name,String description,Runnable action) {
    LinearLayout button=row(); button.setGravity(Gravity.CENTER); button.setLayoutParams(new LinearLayout.LayoutParams(dp(48),dp(48)));
    button.setBackground(ripple(BG,12,false)); button.addView(icon(name,MUTED,22)); clickable(button,description,action); return button;
  }
  private TextView button(LinearLayout parent,String value,boolean primary,Runnable action) {
    TextView button=text(parent,value,14,primary?Color.WHITE:GREEN,true); button.setGravity(Gravity.CENTER);
    button.setMinHeight(dp(48)); button.setPadding(dp(12),dp(12),dp(12),dp(12)); button.setBackground(ripple(primary?GREEN:MINT,11,false));
    clickable(button,value,action==null?() -> {}:action); return button;
  }
  private TextView actionButton(LinearLayout parent,String value,boolean primary,Runnable action) {
    TextView button=button(parent,value,primary,action); LinearLayout.LayoutParams params=new LinearLayout.LayoutParams(-1,-2);
    params.topMargin=dp(10); button.setLayoutParams(params); return button;
  }
  private void menuItem(LinearLayout parent,String value,Runnable action) {
    LinearLayout item=row(); item.setMinimumHeight(dp(54)); TextView label=text(item,value,15,INK,false); weight(label);
    item.addView(icon("chevron",MUTED,16)); item.setBackground(ripple(Color.WHITE,10,false)); clickable(item,value,action); parent.addView(item);
  }
  private void info(LinearLayout parent,String label,String value) {
    info(parent,label,value,MUTED);
  }
  private int debugStateColor(String state) {
    return switch(state) { case "enabled" -> GREEN; case "disabled" -> MUTED; default -> AMBER; };
  }
  private void info(LinearLayout parent,String label,String value,int color) {
    LinearLayout item=row(); item.setPadding(0,dp(14),0,dp(14)); parent.addView(item); TextView name=text(item,label,13,INK,false); weight(name);
    TextView detail=text(item,value,12,color,false); detail.setGravity(Gravity.END); detail.setLayoutParams(new LinearLayout.LayoutParams(0,-2,1.4f));
  }
  private SettingRow setting(LinearLayout parent,String icon,String label,String detail,int id,Runnable action) {
    if (parent.getChildCount()>0) { View line=new View(this); line.setBackgroundColor(LINE); parent.addView(line,new LinearLayout.LayoutParams(-1,dp(1))); }
    SettingRow item=new SettingRow(icon,label,detail,action); if (id!=View.NO_ID) item.view.setId(id);
    parent.addView(item.view,new LinearLayout.LayoutParams(-1,-2)); return item;
  }
  private final class SettingRow {
    final LinearLayout view; final TextView name,detail,value; final HomeIcon icon;
    SettingRow(String glyph,String label,String hint,Runnable action) {
      view=row(); view.setMinimumHeight(dp(80)); view.setPadding(dp(14),dp(14),dp(12),dp(14));
      view.setBackground(ripple(Color.WHITE,10,false)); icon=icon(glyph,MUTED,23); view.addView(icon);
      LinearLayout copy=column(); LinearLayout.LayoutParams params=new LinearLayout.LayoutParams(0,-2,1);
      params.setMarginStart(dp(12)); params.setMarginEnd(dp(6)); view.addView(copy,params);
      name=text(copy,label,14,INK,true); detail=text(copy,hint,11,MUTED,false); detail.setPadding(0,dp(5),0,0);
      value=text(view,"",12,GREEN,false); value.setMaxWidth(dp(88)); value.setGravity(Gravity.END);
      HomeIcon arrow=icon("chevron",0xff92a197,14); LinearLayout.LayoutParams arrowParams=new LinearLayout.LayoutParams(dp(14),dp(14));
      arrowParams.setMarginStart(dp(3)); view.addView(arrow,arrowParams); clickable(view,label+"，查看设置",action);
    }
    void status(String label,int color) { setText(value,label); value.setTextColor(color); view.setContentDescription(name.getText()+"，"+label+"，查看设置"); }
  }
  private final class DebugOption {
    final LinearLayout view;
    final TextView name,value;
    private int statusColor;
    DebugOption(String glyph,String label,String hint,int id,Runnable action) {
      view=column(); view.setId(id); view.setPadding(dp(12),dp(16),dp(12),dp(4));
      view.setBackground(ripple(Color.WHITE,0,false));
      LinearLayout top=row(); top.setGravity(Gravity.TOP); view.addView(top);
      top.addView(icon(glyph,GREEN,26));
      LinearLayout copy=column(); LinearLayout.LayoutParams copyParams=new LinearLayout.LayoutParams(0,-2,1);
      copyParams.setMarginStart(dp(10)); top.addView(copy,copyParams);
      name=text(copy,label,14,INK,true);
      TextView detail=text(copy,hint,11,MUTED,false); detail.setPadding(0,dp(6),0,0); detail.setMinLines(2);
      // Equal-height columns keep status badges and actions aligned when either description wraps.
      view.addView(new View(MainActivity.this),new LinearLayout.LayoutParams(-1,0,1));
      LinearLayout footer=column(); LinearLayout.LayoutParams footerParams=new LinearLayout.LayoutParams(-1,-2);
      footerParams.setMarginStart(dp(36)); footerParams.topMargin=dp(8); view.addView(footer,footerParams);
      value=text(footer,"",12,GREEN,false); value.setPadding(dp(8),dp(5),dp(8),dp(5));
      value.setLayoutParams(new LinearLayout.LayoutParams(-2,-2));
      LinearLayout link=row(); link.setMinimumHeight(dp(48)); footer.addView(link);
      text(link,"查看设置",12,GREEN,false);
      HomeIcon arrow=icon("chevron",MUTED,13); LinearLayout.LayoutParams arrowParams=new LinearLayout.LayoutParams(dp(13),dp(13));
      arrowParams.setMarginStart(dp(6)); link.addView(arrow,arrowParams);
      clickable(view,label+"，查看设置",action);
    }
    void status(String label,int color) {
      setText(value,"●  "+label);
      if (statusColor!=color) {
        statusColor=color; value.setTextColor(color);
        value.setBackground(background(color==GREEN?MINT:color==AMBER?0xfffcf5e9:0xffeff2f0,20,false));
      }
    }
  }
  private void setText(TextView view,String value) { if (!value.contentEquals(view.getText())) view.setText(value); }

  @Override protected void onSaveInstanceState(Bundle state) {
    state.putBoolean("permissionsExpanded",permissionsExpanded); state.putInt("lastPermissionCount",lastPermissionCount);
    state.putBoolean("seenConnected",seenConnected);
    super.onSaveInstanceState(state);
  }
  @Override protected void onResume() {
    super.onResume(); PhoneSettings.cancelPending(); ensureControlService(); if (store.statusEnabled()) startStatusSync();
    main.removeCallbacks(tick); main.post(tick);
  }
  @Override protected void onStart() {
    super.onStart(); visibleHomes++;
    if (ControlService.current!=null) ControlService.current.refreshPresentation();
  }
  @Override protected void onStop() {
    visibleHomes=Math.max(0,visibleHomes-1);
    if (ControlService.current!=null) ControlService.current.refreshPresentation();
    super.onStop();
  }
  @Override protected void onPause() { main.removeCallbacks(tick); super.onPause(); }
  @Override protected void onDestroy() { main.removeCallbacksAndMessages(null); dismissSheet(); io.shutdownNow(); super.onDestroy(); }
}
