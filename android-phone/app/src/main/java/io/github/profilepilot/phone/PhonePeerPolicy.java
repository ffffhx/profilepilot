package io.github.profilepilot.phone;

/** Transport authentication and session ownership are separate authorities. */
final class PhonePeerPolicy {
  private volatile String owner = "";
  void claim(String peer) { owner = peer; }
  boolean owns(String peer) { return owner.equals(peer); }
  void check(String peer, String method, String phase) {
    if (method.equals("sync")) return;
    boolean reserved = !phase.equals("idle") && !phase.equals("stopped") && !phase.equals("disconnected");
    if (reserved && !owns(peer))
      throw new PhoneControlException("PHONE_SESSION_CONFLICT", "手机正由另一条已配对连接使用，请等待原会话结束");
  }
}
