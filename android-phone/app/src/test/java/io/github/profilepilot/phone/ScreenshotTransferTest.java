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

    @Test public void negotiatedFollowFramesKeepSmallRegionsDirectAndPageLargeJpegWithoutResizing() throws Exception {
        start();
        JSONObject region = new ScreenshotRegion(120, 36, 425, 425).toJson();
        JSONObject small = image(new byte[ScreenshotTransfer.CHUNK_CHARS * 3 / 4]).put("mime", "image/jpeg").put("region", region);
        assertSame(small, transfer.offerIfLarge(small, session.instanceId, session.sessionId, session.generation));
        assertFalse(small.has("transfer")); assertEquals(1, session.lastHeartbeat);
        byte[] bytes = new byte[300000]; new Random(77).nextBytes(bytes);
        JSONObject large = image(bytes).put("mime", "image/jpeg").put("region", region);
        JSONObject offered = transfer.offerIfLarge(large, session.instanceId, session.sessionId, session.generation);
        assertEquals("image/jpeg", offered.getString("mime"));
        assertEquals(2772, offered.getInt("width")); assertEquals(1240, offered.getInt("height"));
        assertEquals(new ScreenshotRegion(120, 36, 425, 425), ScreenshotRegion.from(offered.getJSONObject("region")));
        assertFalse(offered.has("base64"));
        region.put("x", 999); assertEquals(120, offered.getJSONObject("region").getInt("x"));
        JSONObject descriptor = offered.getJSONObject("transfer"); String id = descriptor.getString("id");
        StringBuilder assembled = new StringBuilder();
        for (int offset = 0; offset < descriptor.getInt("length"); offset += ScreenshotTransfer.CHUNK_CHARS)
            assembled.append(read(id, offset).getString("base64"));
        assertArrayEquals(bytes, Base64.getDecoder().decode(assembled.toString()));
        assertEquals(1, session.lastHeartbeat);
        JSONObject full = transfer.offerIfLarge(image(bytes).put("mime", "image/jpeg"), session.instanceId, session.sessionId, session.generation);
        assertFalse(full.has("region")); assertTrue(full.has("transfer"));
        String stale = full.getJSONObject("transfer").getString("id");
        transfer.offerIfLarge(image(new byte[90]), session.instanceId, session.sessionId, session.generation);
        assertThrows(IllegalStateException.class, () -> read(stale, 0));
    }

    @Test public void followFrameRegionsAndLateSmallFramesCannotBypassValidation() throws Exception {
        start();
        for (int size : new int[] { 90, 90000 }) {
            JSONObject bad = image(new byte[size]).put("region", new ScreenshotRegion(2600, 0, 425, 425).toJson());
            assertThrows(IllegalArgumentException.class, () -> transfer.offerIfLarge(bad, session.instanceId, session.sessionId, session.generation));
        }
        String instance = session.instanceId, id = session.sessionId; long generation = session.generation;
        session.pause("takeover");
        assertThrows(IllegalStateException.class, () -> transfer.offerIfLarge(image(new byte[90]), instance, id, generation));
        assertThrows(IllegalStateException.class, () -> transfer.offerIfLarge(image(new byte[90000]), instance, id, generation));
    }

    @Test public void cameraProofStaysWithOriginalPixelsAndDoesNotRenewLease() throws Exception {
        start();
        JSONObject proof = new JSONObject().put("version", 1).put("epoch", 2).put("sequence", 4)
            .put("x", 340).put("y", 210).put("heldSinceUptimeMs", 100).put("capturedAtUptimeMs", 300).put("expiresAtUptimeMs", 1300);
        JSONObject frame = image(new byte[90000]).put("cameraProof", proof);
        JSONObject descriptor = transfer.offerIfLarge(frame, session.instanceId, session.sessionId, session.generation);
        String frozen = descriptor.getJSONObject("cameraProof").toString();
        proof.put("epoch", 999).put("x", 900);
        assertEquals(2, descriptor.getJSONObject("cameraProof").getLong("epoch"));
        String id = descriptor.getJSONObject("transfer").getString("id");
        now[0] = 1500; read(id, 0);
        assertEquals(frozen, descriptor.getJSONObject("cameraProof").toString());
        assertEquals(1, session.lastHeartbeat);
        assertFalse(read(id, ScreenshotTransfer.CHUNK_CHARS).has("cameraProof"));
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
