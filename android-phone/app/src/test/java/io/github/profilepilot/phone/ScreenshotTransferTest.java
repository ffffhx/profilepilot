package io.github.profilepilot.phone;

import static org.junit.Assert.*;
import org.json.JSONObject;
import org.junit.Test;
import java.util.Base64;
import java.util.Random;
import java.util.UUID;

public class ScreenshotTransferTest {
    private final long[] now = { 1 };
    private final SessionState session = new SessionState(() -> now[0]);
    private final ScreenshotTransfer transfer = new ScreenshotTransfer(session, () -> now[0]);
    private void start() { session.start(session.instanceId, session.generation, UUID.randomUUID().toString(), "view", "pc", "test", "screenshot", 1); }
    private JSONObject image(byte[] bytes) throws Exception {
        return new JSONObject().put("mime", "image/png").put("base64", Base64.getEncoder().encodeToString(bytes)).put("width", 2772).put("height", 1240);
    }
    private JSONObject offer(byte[] bytes) throws Exception { return transfer.offer(image(bytes), session.instanceId, session.sessionId, session.generation).getJSONObject("transfer"); }
    private JSONObject read(String id, int offset) throws Exception { return transfer.read(session.instanceId, session.sessionId, session.generation, id, offset); }

    @Test public void preservesOneCaptureWithBoundedPagesAndReleasesOnCompletion() throws Exception {
        start(); byte[] bytes = new byte[1024 * 1024]; new Random(33).nextBytes(bytes);
        JSONObject descriptor = offer(bytes); String id = descriptor.getString("id");
        assertEquals(ScreenshotTransfer.CHUNK_CHARS, descriptor.getInt("chunkSize"));
        assertEquals(ScreenshotTransfer.TTL_MS, descriptor.getLong("ttlMs"));
        StringBuilder assembled = new StringBuilder();
        for (int offset = 0; offset < descriptor.getInt("length"); offset += ScreenshotTransfer.CHUNK_CHARS) {
            JSONObject page = read(id, offset);
            assertEquals(id, page.getString("id")); assertEquals(offset, page.getInt("offset"));
            assertTrue(page.toString().length() < 50 * 1024);
            assembled.append(page.getString("base64"));
            assertEquals(assembled.length() == descriptor.getInt("length"), page.getBoolean("done"));
        }
        assertArrayEquals(bytes, Base64.getDecoder().decode(assembled.toString()));
        assertThrows(IllegalStateException.class, () -> read(id, 0));
    }

    @Test public void stopPauseReplacementAndLateCaptureCannotRetainOrReturnPixels() throws Exception {
        start(); String instance = session.instanceId, owner = session.sessionId; long generation = session.generation;
        String id = offer(new byte[90000]).getString("id"); read(id, 0);
        session.pause("takeover"); transfer.prune();
        assertThrows(IllegalStateException.class, () -> transfer.read(instance, owner, generation, id, ScreenshotTransfer.CHUNK_CHARS));
        assertThrows(IllegalStateException.class, () -> transfer.offer(image(new byte[90]), instance, owner, generation));
        session.resume();
        assertThrows(IllegalStateException.class, () -> read(id, 0));
        String stoppedId = offer(new byte[90000]).getString("id");
        session.stop("done"); transfer.prune(); start();
        assertThrows(IllegalStateException.class, () -> read(stoppedId, 0));
    }

    @Test public void chunksNeverRenewLeaseAndCacheExpiresEvenWithRealHeartbeats() throws Exception {
        start(); String id = offer(new byte[90000]).getString("id");
        now[0] = 7000; read(id, 0); assertEquals(1, session.lastHeartbeat);
        now[0] = 8001;
        assertThrows(IllegalStateException.class, () -> read(id, ScreenshotTransfer.CHUNK_CHARS));
        assertEquals("disconnected", session.phase);
        session.stop("test"); start(); String next = offer(new byte[90000]).getString("id");
        for (int i = 0; i < 3; i++) { now[0] += 5000; session.heartbeat(); }
        assertThrows(IllegalStateException.class, () -> read(next, 0));
        assertTrue(session.active());
    }

    @Test public void onlyOneFrameIsRetainedAndWrongOffsetsOrOversizedImagesAreRejected() throws Exception {
        start(); String old = offer(new byte[90000]).getString("id"), current = offer(new byte[90000]).getString("id");
        assertNotEquals(old, current);
        assertThrows(IllegalStateException.class, () -> read(old, 0));
        for (int offset : new int[] { -1, 1, 200000, Integer.MAX_VALUE })
            assertThrows(IllegalArgumentException.class, () -> read(current, offset));
        assertThrows(IllegalStateException.class, () -> transfer.read(session.instanceId, "another", session.generation, current, 0));
        assertThrows(IllegalArgumentException.class, () -> offer(new byte[5 * 1024 * 1024 + 3]));
        transfer.clear(); assertThrows(IllegalStateException.class, () -> read(current, 0));
    }
}
