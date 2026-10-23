package io.github.profilepilot.phone;

import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.view.accessibility.AccessibilityNodeInfo;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.util.Objects;

/** One compact layout for connection, preparation and live session states. */
final class ConnectionCard extends LinearLayout {
  private static final int INK=0xff1c2926, MUTED=0xff647169, GREEN=0xff147457,
      BLUE=0xff235dc0, AMBER=0xff96520b, GRAY=0xff65756f;
  private final LinearLayout iconBox, actions, computerRow;
  private final HomeIcon icon, arrow;
  private final View divider;
  private final TextView title, description, computerLabel, computerName, actionLabel;
  final TextView pause, stop;
  private PhoneHomeState lastState;
  private String lastComputer;
  private boolean lastKnown;

  ConnectionCard(Context context, Runnable details, Runnable settings, Runnable help) {
    super(context); setId(R.id.home_connection); setOrientation(VERTICAL); setPadding(dp(16),dp(16),dp(16),dp(4));
    LinearLayout top=row(); top.setMinimumHeight(dp(44)); addView(top,new LayoutParams(-1,-2));
    iconBox=row(); iconBox.setGravity(Gravity.CENTER); top.addView(iconBox,new LayoutParams(dp(40),dp(40)));
    icon=new HomeIcon(context,"computer-wait",GRAY); iconBox.addView(icon,new LayoutParams(dp(27),dp(27)));
    LinearLayout copy=new LinearLayout(context); copy.setOrientation(VERTICAL);
    LayoutParams copyParams=new LayoutParams(0,-2,1); copyParams.setMarginStart(dp(12)); top.addView(copy,copyParams);
    title=text(copy,"",18,INK,true); title.setId(R.id.home_status);
    title.setAccessibilityLiveRegion(ACCESSIBILITY_LIVE_REGION_POLITE);
    description=text(copy,"",12,MUTED,false); description.setId(R.id.home_status_description); description.setPadding(0,dp(6),0,0);
    actions=row(); LayoutParams actionParams=new LayoutParams(-1,-2); actionParams.topMargin=dp(12); addView(actions,actionParams);
    pause=actionButton(actions,R.id.home_pause); stop=actionButton(actions,R.id.home_stop);
    ((LayoutParams)pause.getLayoutParams()).setMarginEnd(dp(8));
    divider=new View(context); LayoutParams dividerParams=new LayoutParams(-1,dp(1)); dividerParams.topMargin=dp(12); addView(divider,dividerParams);
    computerRow=row(); computerRow.setId(R.id.home_computer); computerRow.setMinimumHeight(dp(48)); addView(computerRow,new LayoutParams(-1,-2));
    computerLabel=text(computerRow,"",12,MUTED,false);
    computerName=text(computerRow,"",14,INK,true); computerName.setSingleLine(true); computerName.setEllipsize(TextUtils.TruncateAt.END);
    LayoutParams nameParams=new LayoutParams(0,-2,1); nameParams.setMarginStart(dp(12)); nameParams.setMarginEnd(dp(8)); computerName.setLayoutParams(nameParams);
    actionLabel=text(computerRow,"",12,MUTED,false);
    arrow=new HomeIcon(context,"chevron",MUTED); LayoutParams arrowParams=new LayoutParams(dp(14),dp(14)); arrowParams.setMarginStart(dp(5)); computerRow.addView(arrow,arrowParams);
    accessibleButton(computerRow); computerRow.setOnClickListener(v -> {
      if (lastState==null) return;
      switch(lastState.action()) { case SETTINGS -> settings.run(); case HELP -> help.run(); default -> details.run(); }
    });
  }

  void render(PhoneHomeState state,String computer,boolean knownComputer) {
    if (state.equals(lastState) && Objects.equals(computer,lastComputer) && knownComputer==lastKnown) return;
    lastState=state; lastComputer=computer; lastKnown=knownComputer;
    int accent, surface, tint, border;
    switch(state.tone()) {
      case CONNECTED -> { accent=GREEN; surface=0xffeef8f2; tint=0xffdcefe4; border=0xffc8e6d7; }
      case ACTIVE -> { accent=BLUE; surface=0xffeff5ff; tint=0xffdce9ff; border=0xffc9ddfc; }
      case ATTENTION -> { accent=AMBER; surface=0xfffff8eb; tint=0xffffedcc; border=0xfff2d9ad; }
      default -> { accent=GRAY; surface=0xfff4f6f5; tint=0xffe8efec; border=0xffdfe7e3; }
    }
    setBackground(background(surface,18,border)); iconBox.setBackground(background(tint,12,0));
    icon.name(state.icon()); icon.color(accent); title.setText(state.title()); title.setTextColor(accent);
    description.setText(state.description()); description.setTextColor(state.needsAttention()?AMBER:MUTED);
    actions.setVisibility(state.controls()?VISIBLE:GONE);
    String mode=state.viewing()?"查看":"控制";
    pause.setText((state.paused()?"继续":"暂停")+mode); pause.setContentDescription(pause.getText());
    pause.setBackground(ripple(state.paused()?GREEN:BLUE,10,0)); pause.setTextColor(Color.WHITE);
    pause.setEnabled(!state.paused() || !state.needsAttention()); pause.setAlpha(pause.isEnabled()?1f:.45f);
    stop.setText("结束"+mode); stop.setContentDescription(stop.getText()); stop.setBackground(ripple(surface,10,0xffaebbb5)); stop.setTextColor(INK);
    boolean footer=knownComputer || state.action()!=PhoneHomeState.Action.DETAILS;
    divider.setVisibility(footer?VISIBLE:GONE); computerRow.setVisibility(footer?VISIBLE:GONE); divider.setBackgroundColor(border);
    setPadding(dp(16),dp(16),dp(16),dp(footer?4:16));
    computerLabel.setText(knownComputer?(state.connected()?"当前电脑":"上次连接"):"USB / Wi-Fi");
    computerName.setText(knownComputer?(computer.isBlank()?"电脑":computer):"");
    String action=switch(state.action()) { case SETTINGS -> "去设置"; case HELP -> "连接帮助"; default -> "详情"; };
    int actionColor=state.action()==PhoneHomeState.Action.DETAILS?MUTED:AMBER;
    actionLabel.setText(action); actionLabel.setTextColor(actionColor); arrow.color(actionColor);
    computerRow.setBackground(ripple(surface,8,0));
    computerRow.setContentDescription(computerLabel.getText()+"，"+computerName.getText()+"，"+action);
  }

  private LinearLayout row() { LinearLayout view=new LinearLayout(getContext()); view.setOrientation(HORIZONTAL); view.setGravity(Gravity.CENTER_VERTICAL); return view; }
  private TextView text(LinearLayout parent,String value,int size,int color,boolean bold) {
    TextView view=new TextView(getContext()); view.setText(value); view.setTextSize(size); view.setTextColor(color); view.setIncludeFontPadding(false);
    view.setLineSpacing(dp(2),1); if (bold) view.setTypeface(null,Typeface.BOLD);
    parent.addView(view,new LayoutParams(parent.getOrientation()==HORIZONTAL?-2:-1,-2)); return view;
  }
  private TextView actionButton(LinearLayout parent,int id) {
    TextView view=text(parent,"",14,INK,true); view.setId(id); view.setGravity(Gravity.CENTER); view.setMinimumHeight(dp(48));
    view.setPadding(dp(8),dp(10),dp(8),dp(10)); view.setLayoutParams(new LayoutParams(0,-2,1)); accessibleButton(view); return view;
  }
  private void accessibleButton(View view) {
    view.setFocusable(true); view.setClickable(true); view.setAccessibilityDelegate(new View.AccessibilityDelegate() {
      @Override public void onInitializeAccessibilityNodeInfo(View host,AccessibilityNodeInfo info) {
        super.onInitializeAccessibilityNodeInfo(host,info); info.setClassName(Button.class.getName());
      }
    });
  }
  private GradientDrawable background(int color,int radius,int border) {
    GradientDrawable drawable=new GradientDrawable(); drawable.setColor(color); drawable.setCornerRadius(dp(radius));
    if (border!=0) drawable.setStroke(dp(1),border); return drawable;
  }
  private RippleDrawable ripple(int color,int radius,int border) { return new RippleDrawable(ColorStateList.valueOf(0x18147757),background(color,radius,border),background(Color.WHITE,radius,0)); }
  private int dp(int value) { return Math.round(value*getResources().getDisplayMetrics().density); }
}
