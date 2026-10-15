package io.github.profilepilot.phone;

/** Home presentation uses live connection evidence, never a remembered pairing as online proof. */
record PhoneHomeState(String title, String description, String badge, Tone tone,
                      boolean controls, boolean paused, boolean viewing) {
  enum Tone { NEUTRAL, CONNECTED, ACTIVE, ATTENTION }

  record Input(boolean connected, boolean debuggingReady, boolean permissionsReady,
               boolean unlocked, boolean seenConnected, boolean hasSession, String phase, String mode) { }

  static PhoneHomeState from(Input input) {
    boolean viewing = "view".equals(input.mode());
    boolean ongoing = input.hasSession()
        && ("paused".equals(input.phase()) || "viewing".equals(input.phase())
            || "controlling".equals(input.phase()) || "executing".equals(input.phase()));
    if (!input.connected()) {
      if (input.seenConnected() || ongoing || "disconnected".equals(input.phase()))
        return new PhoneHomeState("电脑连接中断", "已停止接收操作，等待电脑自动重连。", "已断开", Tone.ATTENTION, false, false, viewing);
      return input.debuggingReady()
          ? new PhoneHomeState("等待电脑自动连接", "调试已开启，连接成功后会自动更新。", "等待连接", Tone.NEUTRAL, false, false, viewing)
          : new PhoneHomeState("还没有电脑连接", "开启 USB 或 Wi-Fi 调试后，电脑会自动连接。", "尚未连接", Tone.NEUTRAL, false, false, viewing);
    }
    if (ongoing && "paused".equals(input.phase()))
      return new PhoneHomeState(viewing ? "查看已暂停" : "控制已暂停",
          !input.unlocked() ? "请先解锁手机，再手动继续。"
              : !input.permissionsReady() ? "请先恢复下方权限，再手动继续。"
              : "现在由你操作，电脑暂时不能操作手机。",
          "已暂停", Tone.ATTENTION, true, true, viewing);
    if (ongoing)
      return new PhoneHomeState(viewing ? "电脑正在查看" : "电脑正在控制",
          viewing ? "电脑可查看屏幕，不能点击或输入。" : "电脑可以读取屏幕、点击和输入。",
          viewing ? "仅查看" : "控制中", Tone.ACTIVE, true, false, viewing);
    return new PhoneHomeState("电脑已连接",
        !input.unlocked() ? "手机已锁屏，解锁后才能开始控制。"
            : input.permissionsReady() ? "连接正常，当前没有在控制手机。" : "连接正常，请先处理下方权限提醒。",
        "连接正常", Tone.CONNECTED, false, false, viewing);
  }
}
