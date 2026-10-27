package io.github.profilepilot.phone;

import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/** Public discovery hints only: never include credentials, hardware IDs or control endpoints. */
final class LanDiscoveryProtocol {
  static final int PORT = 41243;
  static final String GROUP = "239.255.80.80", PROTOCOL = "profilepilot-discovery-v1";
  static byte[] reply(byte[] request, int offset, int length, String id, String name, String version, boolean debug, String wireless) {
    return reply(request, offset, length, id, name, version, debug, wireless, null);
  }
  static byte[] reply(byte[] request, int offset, int length, String id, String name, String version, boolean debug, String wireless, String deviceId) {
    if (length > 256) return null;
    try {
      JSONObject input = new JSONObject(new String(request, offset, length, StandardCharsets.UTF_8));
      String nonce = input.optString("nonce");
      if (!PROTOCOL.equals(input.optString("protocol")) || !"scan".equals(input.optString("type")) || !nonce.matches("[a-f0-9]{32}")) return null;
      return new JSONObject().put("protocol", PROTOCOL).put("type", "phone").put("nonce", nonce)
        .put("id", id).put("deviceId", deviceId).put("name", name.substring(0, Math.min(name.length(), 100)))
        .put("version", version).put("variant", debug ? "debug" : "release").put("wirelessDebugging", wireless)
        .toString().getBytes(StandardCharsets.UTF_8);
    } catch (Exception ignored) { return null; }
  }
}
