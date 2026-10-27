package io.github.profilepilot.phone;

import org.junit.Test;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import static org.junit.Assert.*;

public class LanDiscoveryProtocolTest {
  private byte[] reply(String request) {
    byte[] bytes = request.getBytes(StandardCharsets.UTF_8);
    return LanDiscoveryProtocol.reply(bytes, 0, bytes.length, "b5547b10-3843-487b-ab31-46ec92cf5854", "测试手机", "0.3.6-dev", true, "disabled");
  }
  @Test public void discoversBeforePairingAndDebugging() throws Exception {
    String nonce = "a".repeat(32);
    JSONObject result = new JSONObject(new String(reply(new JSONObject().put("protocol", LanDiscoveryProtocol.PROTOCOL).put("type", "scan").put("nonce", nonce).toString()), StandardCharsets.UTF_8));
    assertEquals(nonce, result.getString("nonce")); assertEquals("测试手机", result.getString("name"));
    assertEquals("disabled", result.getString("wirelessDebugging")); assertEquals("debug", result.getString("variant"));
    assertEquals(8, result.length()); assertFalse(result.has("token")); assertFalse(result.has("hardwareId"));
  }
  @Test public void ignoresMalformedOrUnrelatedDatagrams() throws Exception {
    for (String request : new String[]{"{}", "{", "x".repeat(257), "{\"protocol\":\"profilepilot-discovery-v1\",\"type\":\"scan\",\"nonce\":\"bad\"}"}) assertNull(reply(request));
    assertNull(reply(new JSONObject().put("protocol", LanDiscoveryProtocol.PROTOCOL).put("type", "control").put("nonce", "a".repeat(32)).toString()));
  }
  @Test public void optedInDiscoveryIncludesInstallationIdentityButNoControlCredentials() throws Exception {
    byte[] request = new JSONObject().put("protocol", LanDiscoveryProtocol.PROTOCOL).put("type", "scan").put("nonce", "a".repeat(32)).toString().getBytes(StandardCharsets.UTF_8);
    JSONObject result = new JSONObject(new String(LanDiscoveryProtocol.reply(request, 0, request.length, "temporary", "Phone", "1", true, "disabled", "4adacb66-890f-4faa-8d47-d1862aeb3477"), StandardCharsets.UTF_8));
    assertEquals("4adacb66-890f-4faa-8d47-d1862aeb3477", result.getString("deviceId"));
    assertFalse(result.has("token")); assertFalse(result.has("sessionId")); assertFalse(result.has("hardwareId"));
  }
}
