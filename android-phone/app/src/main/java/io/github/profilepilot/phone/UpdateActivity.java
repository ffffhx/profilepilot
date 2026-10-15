package io.github.profilepilot.phone;

import android.content.ClipData;
import android.content.Intent;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.provider.Settings;
import android.view.View;
import android.view.WindowInsets;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import androidx.activity.ComponentActivity;
import androidx.core.content.FileProvider;
import androidx.lifecycle.Lifecycle;
import java.io.File;
import java.util.Locale;
import java.util.function.Consumer;

/** All updates are user initiated; Android retains the final install confirmation. */
public final class UpdateActivity extends ComponentActivity {
  private static final int GREEN=0xff11775d, INK=0xff1c2926, MUTED=0xff738178, BG=0xfff7f9f7;
  private AppUpdater updater;
  private TextView status,detail,notes,hint;
  private ProgressBar progress;
  private Button action,cancel;
  private final Consumer<AppUpdater.State> listener=this::render;

  @Override public void onCreate(Bundle saved) {
    super.onCreate(saved); updater=AppUpdater.get(this);
    LinearLayout root=new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setBackgroundColor(BG);
    root.setOnApplyWindowInsetsListener((view,insets) -> {
      android.graphics.Insets bars=insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
      view.setPadding(bars.left,bars.top,bars.right,bars.bottom); return insets;
    });
    Button back=new Button(this); back.setText("‹  返回"); back.setTextColor(GREEN); back.setBackgroundColor(BG);
    back.setOnClickListener(view -> finish()); root.addView(back,new LinearLayout.LayoutParams(-2,dp(52)));
    ScrollView scroll=new ScrollView(this); root.addView(scroll,new LinearLayout.LayoutParams(-1,0,1));
    LinearLayout page=new LinearLayout(this); page.setOrientation(LinearLayout.VERTICAL); page.setPadding(dp(24),dp(16),dp(24),dp(32)); scroll.addView(page);
    text(page,"软件更新",28,INK,true);
    text(page,"当前版本 "+BuildConfig.VERSION_NAME,14,MUTED,false);
    LinearLayout card=new LinearLayout(this); card.setOrientation(LinearLayout.VERTICAL); card.setPadding(dp(20),dp(20),dp(20),dp(20));
    GradientDrawable background=new GradientDrawable(); background.setColor(0xffffffff); background.setCornerRadius(dp(20)); card.setBackground(background);
    LinearLayout.LayoutParams cardParams=new LinearLayout.LayoutParams(-1,-2); cardParams.topMargin=dp(28); page.addView(card,cardParams);
    status=text(card,"正在检查更新…",20,INK,true); status.setId(R.id.update_status); status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
    detail=text(card,"",13,MUTED,false);
    progress=new ProgressBar(this,null,android.R.attr.progressBarStyleHorizontal); progress.setMax(100); card.addView(progress,new LinearLayout.LayoutParams(-1,dp(16)));
    notes=text(card,"",14,INK,false); notes.setTextIsSelectable(true);
    action=new Button(this); action.setId(R.id.update_action); action.setTextColor(0xffffffff); action.setBackgroundTintList(android.content.res.ColorStateList.valueOf(GREEN));
    LinearLayout.LayoutParams buttonParams=new LinearLayout.LayoutParams(-1,-2); buttonParams.topMargin=dp(16); card.addView(action,buttonParams);
    action.setOnClickListener(view -> act());
    cancel=new Button(this); cancel.setText("取消下载"); cancel.setTextColor(MUTED); cancel.setBackgroundColor(0xffffffff); card.addView(cancel); cancel.setOnClickListener(view -> updater.cancel());
    hint=text(page,"更新后会保留配对信息和设置。安装前请先结束手机控制或查看会话。",13,MUTED,false); hint.setPadding(0,dp(24),0,0);
    setContentView(root);
    if (updater.state().stage()==AppUpdater.Stage.IDLE
        || saved==null && !updater.state().busy() && updater.state().stage()!=AppUpdater.Stage.READY) updater.check();
  }
  @Override protected void onStart() { super.onStart(); updater.observe(listener); }
  @Override protected void onStop() { updater.remove(listener); super.onStop(); }
  @Override protected void onResume() { super.onResume(); if (updater!=null) render(updater.state()); }

  private void render(AppUpdater.State state) {
    if (state.stage()==AppUpdater.Stage.DEVELOPMENT) {
      status.setText(state.message());
      detail.setText("开发版由电脑构建和安装，不接收正式版更新。"); detail.setVisibility(View.VISIBLE);
      notes.setVisibility(View.GONE); progress.setVisibility(View.GONE);
      action.setVisibility(View.GONE); cancel.setVisibility(View.GONE);
      hint.setText("日常使用和在线更新请打开 ProfilePilot 移动版。两个版本可以同时安装，数据和权限分别保存。");
      return;
    }
    status.setText(state.message()); UpdateRelease release=state.release();
    boolean newer=release!=null && release.newerThan(BuildConfig.VERSION_CODE);
    detail.setText(newer ? "版本 "+release.versionName()+"  ·  "+String.format(Locale.getDefault(),"%.1f MB",release.size()/1048576.0) : "");
    detail.setVisibility(newer?View.VISIBLE:View.GONE);
    notes.setText(newer && !release.notes().isBlank()?"更新内容\n\n"+release.notes():"");
    notes.setVisibility(notes.length()>0?View.VISIBLE:View.GONE);
    progress.setVisibility(state.busy()?View.VISIBLE:View.GONE);
    progress.setIndeterminate(state.stage()!=AppUpdater.Stage.DOWNLOADING);
    progress.setProgress(state.percent());
    if (state.stage()==AppUpdater.Stage.DOWNLOADING) status.setText("正在下载 "+state.percent()+"%");
    cancel.setVisibility(state.stage()==AppUpdater.Stage.DOWNLOADING?View.VISIBLE:View.GONE);
    action.setEnabled(!state.busy());
    action.setText(switch(state.stage()) {
      case AVAILABLE -> "下载新版";
      case READY -> getPackageManager().canRequestPackageInstalls()?"安装新版":"允许安装此来源的应用";
      case DOWNLOADING -> "下载中…";
      case CHECKING, VERIFYING -> "请稍候…";
      case ERROR -> "重试检查更新";
      default -> "重新检查";
    });
    if (state.stage()==AppUpdater.Stage.READY) hint.setText(getPackageManager().canRequestPackageInstalls()
        ? "点击安装后，请在系统界面确认。配对信息和设置会保留。"
        : "首次更新需要允许 ProfilePilot 安装应用。开启后返回此页，再点击“安装新版”。");
    else hint.setText(state.stage()==AppUpdater.Stage.DOWNLOADING ? "请保持 App 打开，等待下载完成。更新不会清除配对信息和设置。"
        : "更新后会保留配对信息和设置。安装前请先结束手机控制或查看会话。");
  }

  private void act() {
    if (updater.state().stage()==AppUpdater.Stage.AVAILABLE) { updater.download(); return; }
    if (updater.state().stage()!=AppUpdater.Stage.READY) { updater.check(); return; }
    if (sessionBusy()) { message("请先结束手机控制或查看会话，再安装更新"); return; }
    if (!getPackageManager().canRequestPackageInstalls()) {
      try { startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,Uri.parse("package:"+getPackageName()))); }
      catch (RuntimeException error) { message("无法打开安装授权，请在系统设置中允许 ProfilePilot 安装未知应用"); }
      return;
    }
    updater.prepareInstall(file -> {
      if (!getLifecycle().getCurrentState().isAtLeast(Lifecycle.State.RESUMED)) return;
      if (sessionBusy()) { message("请先结束手机控制或查看会话，再安装更新"); return; }
      try { startActivity(installIntent(file)); }
      catch (RuntimeException error) { message("无法打开系统安装界面，请检查安装授权后重试"); }
    });
  }
  Intent installIntent(File file) {
    Uri uri=FileProvider.getUriForFile(this,getPackageName()+".updates",file);
    Intent intent=new Intent(Intent.ACTION_VIEW).setDataAndType(uri,"application/vnd.android.package-archive")
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
    intent.setClipData(ClipData.newRawUri("ProfilePilot 更新",uri)); return intent;
  }
  private boolean sessionBusy() {
    ControlService service=ControlService.current;
    return service!=null && (service.session.active() || "paused".equals(service.session.phase));
  }
  private void message(String value) { Toast.makeText(this,value,Toast.LENGTH_LONG).show(); }
  private int dp(int value) { return Math.round(value*getResources().getDisplayMetrics().density); }
  private TextView text(LinearLayout parent,String value,int size,int color,boolean bold) {
    TextView view=new TextView(this); view.setText(value); view.setTextSize(size); view.setTextColor(color);
    view.setPadding(0,0,0,dp(12)); if (bold) view.setTypeface(null,Typeface.BOLD); parent.addView(view); return view;
  }
}
