package io.github.profilepilot.phone;

import static org.junit.Assert.*;

import org.json.JSONObject;
import org.junit.Test;

public class RemoteClientTest {
  @Test
  public void endpointSupportsLanVpnAndIpv6WithoutCredentialLeakage() throws Exception {
    assertEquals("https://192.168.1.4:4200", RemoteClient.endpoint(" https://192.168.1.4:4200/ "));
    assertEquals("https://my-pc.example", RemoteClient.endpoint("https://my-pc.example"));
    assertEquals("https://[::1]:4400", RemoteClient.endpoint("https://[::1]:4400"));
    for (String bad :
        new String[] {
          "http://192.168.1.4:4200",
          "https://user:password@host",
          "https://host/path",
          "https://host?token=secret",
          "https://host#x",
          "https://host:99999",
          "file:///foo",
          ""
        }) {
      try {
        RemoteClient.endpoint(bad);
        fail("Accepted unsafe endpoint: " + bad);
      } catch (Exception expected) {
        /* rejected */
      }
    }
  }

  @Test
  public void independentOperationsGetUniqueReplayIdentifiersAndCreationTime() throws Exception {
    JSONObject command = RemoteClient.object("action", "task.create", "profile", "native:Default");
    JSONObject first = RemoteClient.envelope(command), second = RemoteClient.envelope(command);
    assertNotEquals(first.getString("requestId"), second.getString("requestId"));
    assertTrue(Math.abs(System.currentTimeMillis() - first.getLong("issuedAt")) < 2000);
    assertEquals(command.toString(), first.getJSONObject("command").toString());
  }
}
