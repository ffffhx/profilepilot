package io.github.profilepilot.phone;

import org.junit.Test;
import org.json.JSONObject;
import java.net.URLEncoder;
import java.util.UUID;
import static org.junit.Assert.*;

public class InternetPhoneProtocolTest {
  private String link() throws Exception {
    return "profilepilot-dev://internet?v=1&id="+UUID.randomUUID()+"&url="+URLEncoder.encode("https://cloud.example:18770","UTF-8")
        +"&fp="+"a".repeat(64)+"&token="+"b".repeat(64)+"&name=Cloud";
  }
  @Test public void pairsOnlyExplicitPinnedHttpsControlLinks() throws Exception {
    String link=link(); JSONObject value=InternetPhoneProtocol.parse(link,"profilepilot-dev");
    assertEquals("https://cloud.example:18770",value.getString("url"));
    assertEquals("Cloud",value.getString("computer"));
    for (String invalid:new String[]{link+"&v=1",link+"&extra=x",link+"#x",link.replace("://internet","://status"),link.replace("v=1","v=2"),link.replace("https%3A","http%3A"),link.replace("fp=aaa","fp=xyz")})
      assertThrows(Exception.class,()->InternetPhoneProtocol.parse(invalid,"profilepilot-dev"));
    assertThrows(Exception.class,()->InternetPhoneProtocol.parse(link,"profilepilot"));
  }
  @Test public void rejectsRedirectOriginsCredentialsPathsAndExpiredCommands() throws Exception {
    for (String invalid:new String[]{"http://host","https://user:password@host","https://host/api","https://host/?token=abc","https://host/#fragment","https://host:0"})
      assertThrows(Exception.class,()->InternetPhoneProtocol.endpoint(invalid));
    String connection=UUID.randomUUID().toString();
    JSONObject command=new JSONObject().put("id",UUID.randomUUID().toString()).put("connectionId",connection)
        .put("method","action").put("body",new JSONObject()).put("expiresAt",2000);
    InternetPhoneProtocol.validateCommand(command,connection,1000);
    assertThrows(Exception.class,()->InternetPhoneProtocol.validateCommand(command,UUID.randomUUID().toString(),1000));
    assertThrows(Exception.class,()->InternetPhoneProtocol.validateCommand(command,connection,2000));
    command.put("expiresAt",50000);
    assertThrows(Exception.class,()->InternetPhoneProtocol.validateCommand(command,connection,1000));
    command.put("expiresAt",2000).put("method","shell");
    assertThrows(Exception.class,()->InternetPhoneProtocol.validateCommand(command,connection,1000));
  }
  @Test public void anotherPairedTransportCannotBorrowAnOwnedLease() {
    PhonePeerPolicy peers=new PhonePeerPolicy(); peers.claim("adb");
    assertTrue(peers.owns("adb")); assertFalse(peers.owns("internet:cloud"));
    for (String phase:new String[]{"viewing","controlling","executing","paused"}) {
      peers.check("internet:cloud","sync",phase);
      for (String method:new String[]{"start","pause","resume","stop","action","unattended","package-install"})
        assertThrows(PhoneControlException.class,()->peers.check("internet:cloud",method,phase));
    }
    peers.check("internet:cloud","start","stopped"); peers.claim("internet:cloud");
    assertThrows(PhoneControlException.class,()->peers.check("adb","action","controlling"));
    peers.check("internet:cloud","action","controlling");
  }
}
