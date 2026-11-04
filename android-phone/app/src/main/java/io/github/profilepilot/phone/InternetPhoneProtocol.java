package io.github.profilepilot.phone;

import java.net.URI;
import java.net.URLDecoder;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.json.JSONObject;

/** Pairing pins one cloud computer; a status-sync link never grants control. */
final class InternetPhoneProtocol {
  private static final Set<String> FIELDS = Set.of("v", "id", "url", "fp", "token", "name");
  private static final Set<String> METHODS = Set.of("sync", "start", "pause", "resume", "stop", "action",
      "screenshot-chunk", "unattended", "accessibility-recovery", "package-inspect", "package-launch",
      "package-install", "package-install-status", "package-install-receipt", "package-install-cancel", "wake");

  static String endpoint(String value) throws Exception {
    URI uri = new URI(value);
    if (!"https".equals(uri.getScheme()) || uri.getHost() == null || uri.getRawUserInfo() != null
        || uri.getRawQuery() != null || uri.getRawFragment() != null || uri.getPort() == 0 || uri.getPort() > 65535
        || !(uri.getRawPath().isEmpty() || uri.getRawPath().equals("/")))
      throw new IllegalArgumentException("请使用电脑生成的 HTTPS 外网控制地址");
    return value.replaceAll("/+$", "");
  }
  static JSONObject parse(String value, String scheme) throws Exception {
    if (value.length() > 8192) throw new IllegalArgumentException("配对链接过长");
    URI uri = new URI(value.trim());
    if (!scheme.equals(uri.getScheme()) || !"internet".equals(uri.getHost()) || uri.getRawUserInfo() != null
        || uri.getPort() != -1 || !uri.getRawPath().isEmpty() || uri.getRawFragment() != null || uri.getRawQuery() == null)
      throw new IllegalArgumentException("请使用当前版本的外网控制配对链接");
    Map<String, String> fields = new HashMap<>();
    for (String part : uri.getRawQuery().split("&")) {
      int equals = part.indexOf('=');
      if (equals < 1) throw new IllegalArgumentException("配对链接不完整");
      String key = URLDecoder.decode(part.substring(0, equals), "UTF-8");
      String entry = URLDecoder.decode(part.substring(equals + 1), "UTF-8");
      if (!FIELDS.contains(key) || fields.put(key, entry) != null) throw new IllegalArgumentException("配对链接包含重复或未知字段");
    }
    if (!fields.keySet().equals(FIELDS) || !"1".equals(fields.get("v"))) throw new IllegalArgumentException("外网控制协议版本不支持");
    String id = fields.get("id"), pin = fields.get("fp"), token = fields.get("token"), name = fields.get("name");
    if (!UUID.fromString(id).toString().equals(id) || !pin.matches("[a-f0-9]{64}") || !token.matches("[a-f0-9]{64}")
        || name.isBlank() || name.length() > 120 || name.matches("(?s).*[\\p{Cntrl}].*"))
      throw new IllegalArgumentException("配对电脑身份不完整");
    return new JSONObject().put("serverId", id).put("url", endpoint(fields.get("url")))
        .put("fingerprint", pin).put("pairToken", token).put("computer", name);
  }
  static void validateCommand(JSONObject command, String connectionId, long now) throws Exception {
    String id = command.getString("id");
    if (!UUID.fromString(id).toString().equals(id) || !connectionId.equals(command.getString("connectionId"))
        || !METHODS.contains(command.getString("method")) || !(command.get("body") instanceof JSONObject))
      throw new IllegalArgumentException("外网控制请求身份或类型无效");
    long deadline = command.getLong("expiresAt");
    if (deadline <= now || deadline - now > 30000) throw new IllegalArgumentException("外网控制请求已过期或时钟不同步");
  }
}
