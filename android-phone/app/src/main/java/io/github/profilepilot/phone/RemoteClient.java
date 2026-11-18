package io.github.profilepilot.phone;

import java.net.URI;
import java.security.MessageDigest;
import java.security.cert.X509Certificate;
import java.util.Locale;
import java.util.UUID;
import org.json.JSONException;
import org.json.JSONObject;

final class RemoteClient {
  private RemoteClient() {}

  static JSONObject object(Object... values) {
    JSONObject out = new JSONObject();
    try {
      for (int i = 0; i < values.length; i += 2) out.put((String) values[i], values[i + 1]);
    } catch (JSONException error) {
      throw new IllegalArgumentException(error);
    }
    return out;
  }

  static String endpoint(String text) throws Exception {
    URI value = new URI(text.trim());
    if (!"https".equals(value.getScheme())
        || value.getHost() == null
        || value.getRawUserInfo() != null
        || value.getRawQuery() != null
        || value.getRawFragment() != null
        || !(value.getPath().isEmpty() || value.getPath().equals("/"))
        || value.getPort() > 65535)
      throw new IllegalArgumentException("请输入完整 HTTPS 电脑地址，不能带路径、凭据或查询参数");
    return new URI("https", null, value.getHost(), value.getPort(), null, null, null).toString();
  }

  static String fingerprint(X509Certificate cert) throws Exception {
    byte[] digest = MessageDigest.getInstance("SHA-256").digest(cert.getEncoded());
    StringBuilder out = new StringBuilder();
    for (byte b : digest) out.append(String.format(Locale.ROOT, "%02x", b & 255));
    return out.toString();
  }

  static JSONObject envelope(JSONObject command) {
    return object(
        "requestId",
        UUID.randomUUID().toString(),
        "issuedAt",
        System.currentTimeMillis(),
        "command",
        command);
  }
}
