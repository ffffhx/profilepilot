package io.github.profilepilot.phone;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class SmsOutboxTest {
    @Test public void offlineQueueExpiresAndOnlyRemovesConfirmedMessages() throws Exception {
        long now = 3L * 86400000;
        JSONArray queued = new JSONArray();
        queued.put(new JSONObject().put("messageId","expired").put("receivedAt",0));
        queued.put(new JSONObject().put("messageId","first").put("receivedAt",now - 1000));
        queued.put(new JSONObject().put("messageId","second").put("receivedAt",now));
        JSONArray outstanding = SmsOutbox.retained(queued, "", now);
        assertEquals(2, outstanding.length());
        assertEquals("first", outstanding.getJSONObject(0).getString("messageId"));
        JSONArray remaining = SmsOutbox.retained(outstanding, "first", now);
        assertEquals(1, remaining.length());
        assertEquals("second", remaining.getJSONObject(0).getString("messageId"));
        assertEquals(remaining.toString(), SmsOutbox.retained(remaining, "first", now).toString());
    }
}
