package io.github.profilepilot.phone;

import android.content.Context;
import android.net.Uri;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONObject;

/** A diagnostic-only HTTPS client. Default Android trust validation is mandatory. */
final class StatusSyncClient {
  static final String DEFAULT_URL = "https://124-221-36-36.anyip.dev:8443/profilepilot-status";
  private static final Object DEVICE_LOCK = new Object();
  static JSONObject createDeviceCode(Context context, String url, JSONObject report) throws Exception {
    synchronized (DEVICE_LOCK) {
      ComputerStore store = new ComputerStore(context);
      org.json.JSONArray links = store.deviceLinks();
      if (links.length() >= 8) throw new IllegalStateException("已保存 8 个设备码连接，请先移除不再使用的连接");
      byte[] bytes = new byte[32]; new SecureRandom().nextBytes(bytes);
      StringBuilder secret = new StringBuilder();
      for (byte b : bytes) secret.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
      JSONObject link = new JSONObject().put("url", endpoint(url)).put("id", java.util.UUID.randomUUID().toString()).put("token", secret.toString());
      JSONObject response = request(link, "device-code-create", secret.toString(), new JSONObject().put("report", report));
      link.put("code", response.getString("code")).put("expires", response.getLong("expires")).put("paired", false);
      links.put(link); store.deviceLinks(links); store.deviceSyncEnabled(true);
      return link;
    }
  }
  static void syncDeviceCodes(Context context, JSONObject report) throws Exception {
    synchronized (DEVICE_LOCK) {
      ComputerStore store = new ComputerStore(context);
      org.json.JSONArray links = store.deviceLinks(), kept = new org.json.JSONArray();
      Exception failure = null;
      for (int i = 0; i < links.length(); i++) {
        JSONObject link = links.getJSONObject(i);
        try {
          JSONObject result = request(link, "report", link.getString("token"), new JSONObject().put("report", report));
          if (result.optBoolean("paired")) { link.put("paired", true); link.remove("code"); }
        } catch (StatusException error) {
          if (error.status == 404 || error.status == 401) continue;
          failure = error;
        } catch (Exception error) { failure = error; }
        kept.put(link);
      }
      store.deviceLinks(kept);
      if (kept.length() == 0) store.deviceSyncEnabled(false);
      if (failure != null) throw failure;
    }
  }
  static void revokeDeviceCode(Context context, String id) throws Exception {
    synchronized (DEVICE_LOCK) {
      ComputerStore store = new ComputerStore(context);
      org.json.JSONArray links = store.deviceLinks(), kept = new org.json.JSONArray();
      for (int i = 0; i < links.length(); i++) {
        JSONObject link = links.getJSONObject(i);
        if (!id.equals(link.getString("id"))) { kept.put(link); continue; }
        try { request(link, "device-code-revoke", link.getString("token"), new JSONObject()); }
        catch (StatusException error) { if (error.status != 404) throw error; }
      }
      store.deviceLinks(kept); if (kept.length() == 0) store.deviceSyncEnabled(false);
    }
  }
  private static final class StatusException extends java.io.IOException {
    final int status;
    StatusException(int status) { super(status == 401 || status == 403 || status == 404 ? "设备码或同步配对已失效，请重新生成" : "状态服务器暂不可用（" + status + "），请稍后重试或更新服务器"); this.status = status; }
  }
  static String endpoint(String value) throws Exception {
    java.net.URI uri = new java.net.URI(value);
    if (!"https".equals(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null
        || uri.getQuery() != null || uri.getFragment() != null) throw new IllegalArgumentException("状态服务器必须使用 HTTPS");
    return value.replaceAll("/+$", "");
  }

  static JSONObject parse(String value) throws Exception {
    Uri uri = Uri.parse(value.trim());
    if (!BuildConfig.PAIRING_SCHEME.equals(uri.getScheme()) || !"status".equals(uri.getHost())) throw new IllegalArgumentException("请使用当前版本对应的电脑配对链接");
    String id = uri.getQueryParameter("id"), token = uri.getQueryParameter("token");
    if (id == null || !id.matches("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}")
        || token == null || !token.matches("[a-f0-9]{64}")) throw new IllegalArgumentException("配对信息不完整");
    return new JSONObject().put("url", endpoint(uri.getQueryParameter("url"))).put("id", id).put("pairToken", token);
  }

  static JSONObject request(JSONObject link, String action, String token, JSONObject extra) throws Exception {
    HttpsURLConnection connection = (HttpsURLConnection) new URL(endpoint(link.getString("url")) + "/v1/" + action).openConnection();
    try {
      connection.setInstanceFollowRedirects(false); connection.setConnectTimeout(8000); connection.setReadTimeout(8000);
      connection.setRequestMethod("POST"); connection.setDoOutput(true);
      connection.setRequestProperty("Authorization", "Bearer " + token);
      connection.setRequestProperty("Content-Type", "application/json");
      byte[] body = extra.put("id", link.getString("id")).toString().getBytes(StandardCharsets.UTF_8);
      connection.setFixedLengthStreamingMode(body.length);
      try (java.io.OutputStream out = connection.getOutputStream()) { out.write(body); }
      int status = connection.getResponseCode();
      if (status != 200) throw new StatusException(status);
      try (java.io.InputStream in = connection.getInputStream(); java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream()) {
        byte[] buffer = new byte[1024]; int count;
        while ((count = in.read(buffer)) != -1) { out.write(buffer, 0, count); if (out.size() > 16384) throw new java.io.IOException("状态响应过大"); }
        return new JSONObject(out.toString(StandardCharsets.UTF_8.name()));
      }
    } finally { connection.disconnect(); }
  }

  static void pair(Context context, JSONObject target) throws Exception {
    ComputerStore store = new ComputerStore(context);
    JSONObject pending = store.statusLink(true);
    if (pending == null || !pending.optString("id").equals(target.getString("id")) || !pending.optString("url").equals(target.getString("url")) || !pending.optString("pairToken").equals(target.getString("pairToken"))) {
      byte[] bytes = new byte[32]; new SecureRandom().nextBytes(bytes); StringBuilder token = new StringBuilder();
      for (byte b : bytes) token.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
      pending = new JSONObject(target.toString()).put("token", token.toString());
      store.statusLink(pending, true);
    }
    request(pending, "claim", pending.getString("pairToken"), new JSONObject().put("writeToken", pending.getString("token")).put("deviceId", store.clientId()));
    pending.remove("pairToken"); store.statusLink(pending, false); store.statusLink(null, true); store.statusEnabled(true);
  }

  static JSONObject report(Context context) throws Exception {
    PhoneReadiness readiness = new PhoneReadiness(context);
    String name = android.os.Build.MODEL;
    return new JSONObject().put("deviceId", new ComputerStore(context).clientId()).put("name", name.substring(0, Math.min(name.length(), 80)))
        .put("permissions", new JSONObject().put("overlay", readiness.overlay).put("notifications", readiness.notifications).put("accessibility", readiness.accessibilityService.equals("running")))
        .put("readiness", readiness.json());
  }
}
