package io.github.profilepilot.phone;

/** Connection evidence and control authority are independent of remembered pairing and setup. */
record PhoneHomeState(Kind kind, String title, String description, boolean viewing, boolean needsAttention) {
  enum Tone { NEUTRAL, CONNECTED, ACTIVE, ATTENTION }
  enum Kind { WAITING, UNAVAILABLE, DISCONNECTED, CONNECTED, VIEWING, CONTROLLING, PAUSED }
  enum Debugging { READY, OFF, UNKNOWN }
  enum Action { DETAILS, SETTINGS, HELP }

  record Input(boolean connected, Debugging debugging, boolean permissionsReady,
               boolean unlocked, boolean seenConnected, boolean hasSession, String phase, String mode) { }

  static Debugging debugging(String usb, String wifi) {
    if ("enabled".equals(usb) || "enabled".equals(wifi)) return Debugging.READY;
    return "disabled".equals(usb) && "disabled".equals(wifi) ? Debugging.OFF : Debugging.UNKNOWN;
  }
  Tone tone() {
    return switch (kind) {
      case WAITING -> Tone.NEUTRAL;
      case CONNECTED -> Tone.CONNECTED;
      case VIEWING, CONTROLLING -> Tone.ACTIVE;
      default -> Tone.ATTENTION;
    };
  }
  boolean controls() { return kind == Kind.VIEWING || kind == Kind.CONTROLLING || paused(); }
  boolean paused() { return kind == Kind.PAUSED; }
  boolean connected() { return kind == Kind.CONNECTED || controls(); }
  String icon() {
    return switch (kind) {
      case WAITING -> "computer-wait";
      case UNAVAILABLE -> "computer-alert";
      case DISCONNECTED -> "disconnected";
      case CONNECTED -> "computer-check";
      case VIEWING -> "eye";
      case CONTROLLING -> "computer-control";
      case PAUSED -> "pause-circle";
    };
  }
  Action action() {
    if (kind == Kind.UNAVAILABLE || kind == Kind.WAITING && needsAttention) return Action.SETTINGS;
    return kind == Kind.DISCONNECTED ? Action.HELP : Action.DETAILS;
  }

  static PhoneHomeState from(Input input) {
    boolean viewing = "view".equals(input.mode());
    boolean ongoing = input.hasSession()
        && ("paused".equals(input.phase()) || "viewing".equals(input.phase())
            || "controlling".equals(input.phase()) || "executing".equals(input.phase()));
    if (!input.connected()) {
      if (input.debugging() == Debugging.OFF)
        return new PhoneHomeState(Kind.UNAVAILABLE, "暂时无法连接", "请开启 USB 或 Wi-Fi 调试", viewing, true);
      if (input.seenConnected() || ongoing || "disconnected".equals(input.phase()))
        return new PhoneHomeState(Kind.DISCONNECTED, "电脑连接中断", "已停止操作，等待电脑自动重连", viewing, true);
      return new PhoneHomeState(Kind.WAITING, "等待电脑连接",
          input.debugging() == Debugging.READY ? "调试已开启，请保持电脑端运行" : "调试状态待确认，请检查连接设置",
          viewing, input.debugging() == Debugging.UNKNOWN);
    }
    if (ongoing && "paused".equals(input.phase()))
      return new PhoneHomeState(Kind.PAUSED, viewing ? "查看已暂停" : "控制已暂停",
          !input.unlocked() ? "请先解锁手机，再手动继续"
              : !input.permissionsReady() ? "请先恢复下方权限，再手动继续"
              : viewing ? "屏幕查看已暂停，需手动继续" : "当前由你操作，电脑操作已暂停",
          viewing, !input.unlocked() || !input.permissionsReady());
    if (ongoing)
      return new PhoneHomeState(viewing ? Kind.VIEWING : Kind.CONTROLLING,
          viewing ? "电脑正在查看" : "电脑正在控制",
          viewing ? "仅查看屏幕，不能点击或输入" : "可以读取屏幕、点击和输入", viewing, false);
    return new PhoneHomeState(Kind.CONNECTED, "电脑已连接",
        !input.unlocked() ? "手机已锁屏，解锁后才能控制"
            : input.permissionsReady() ? "连接正常，当前未控制手机" : "权限尚未就绪，请检查下方权限",
        viewing, !input.unlocked() || !input.permissionsReady());
  }
}
