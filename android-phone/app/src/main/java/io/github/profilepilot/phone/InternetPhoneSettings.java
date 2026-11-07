package io.github.profilepilot.phone;

import android.content.Context;
import android.content.SharedPreferences;
import java.security.SecureRandom;
import org.json.JSONObject;

final class InternetPhoneSettings {
  private static SharedPreferences preferences(Context context) { return context.getSharedPreferences("InternetControl", Context.MODE_PRIVATE); }
  static JSONObject link(Context context) {
    try { String value = preferences(context).getString("link", ""); return value.isEmpty() ? null : new JSONObject(value); }
    catch (Exception error) { return null; }
  }
  static boolean enabled(Context context) { return preferences(context).getBoolean("enabled", false) && link(context) != null; }
  static void enabled(Context context, boolean value) { preferences(context).edit().putBoolean("enabled", value).apply(); }
  static void forget(Context context) { preferences(context).edit().remove("link").remove("pending").putBoolean("enabled", false).apply(); }
  static String name(Context context) { JSONObject value = link(context); return value == null ? "未配对云端电脑" : value.optString("computer", "云端电脑"); }

  static synchronized void pair(Context context, JSONObject target) throws Exception {
    ControlService service = ControlService.current;
    // An explicitly confirmed pairing may be prepared by the current local
    // controller. It grants no session to the cloud and never resumes a pause.
    if (service != null && !service.canPairInternet()) throw new IllegalStateException("请先结束当前手机控制会话，再配对云端电脑");
    JSONObject old = link(context);
    if (old != null) throw new IllegalStateException("已有外网控制连接，请先在手机移除后重新配对");
    SharedPreferences prefs = preferences(context);
    JSONObject pending = null;
    try { pending = new JSONObject(prefs.getString("pending", "")); } catch (Exception ignored) { }
    if (pending == null || !pending.optString("pairToken").equals(target.getString("pairToken"))
        || !pending.optString("serverId").equals(target.getString("serverId"))
        || !pending.optString("fingerprint").equals(target.getString("fingerprint")) || !pending.optString("url").equals(target.getString("url"))) {
      byte[] bytes = new byte[32]; new SecureRandom().nextBytes(bytes);
      StringBuilder token = new StringBuilder(); for (byte value : bytes) token.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
      pending = new JSONObject(target.toString()).put("token", token.toString()).put("deviceId", new ComputerStore(context).clientId());
      if (!prefs.edit().putString("pending", pending.toString()).commit()) throw new java.io.IOException("无法保存待确认的配对信息");
    }
    JSONObject response = InternetPhoneTransport.request(pending, "/v1/pair", pending.getString("pairToken"),
        new JSONObject().put("serverId", pending.getString("serverId")).put("deviceId", pending.getString("deviceId"))
          .put("token", pending.getString("token")).put("name", android.os.Build.MODEL));
    if (!pending.getString("serverId").equals(response.getString("serverId")) || !pending.getString("deviceId").equals(response.getString("deviceId")))
      throw new java.io.IOException("配对身份不一致");
    pending.remove("pairToken"); pending.put("computer", response.getString("computer"));
    if (!prefs.edit().putString("link", pending.toString()).remove("pending").putBoolean("enabled", true).commit())
      throw new java.io.IOException("无法保存云端电脑配对");
  }
}
