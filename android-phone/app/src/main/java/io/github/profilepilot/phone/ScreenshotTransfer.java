package io.github.profilepilot.phone;

import org.json.JSONObject;
import java.util.UUID;
import java.util.function.LongSupplier;

/** A single immutable screenshot. Chunk reads do not renew the phone's control lease. */
final class ScreenshotTransfer {
    static final String PROTOCOL = "base64-chunks-v1";
    static final int CHUNK_CHARS = 48 * 1024, MAX_CHARS = ((5 * 1024 * 1024 + 2) / 3) * 4;
    static final long TTL_MS = 15000;
    private final SessionState session;
    private final LongSupplier clock;
    private Entry entry;
    private record Entry(String id, String instanceId, String sessionId, long generation, long at, String base64) { }

    ScreenshotTransfer(SessionState session, LongSupplier clock) { this.session = session; this.clock = clock; }

    JSONObject offer(JSONObject image, String instanceId, String sessionId, long generation) throws Exception {
        session.authorize(instanceId, sessionId, generation, false);
        JSONObject metadata = metadata(image);
        String base64 = image.getString("base64");
        entry = new Entry(UUID.randomUUID().toString(), instanceId, sessionId, generation, clock.getAsLong(), base64);
        return metadata.put("transfer", new JSONObject().put("protocol", 1).put("id", entry.id).put("length", base64.length())
            .put("chunkSize", CHUNK_CHARS).put("ttlMs", TTL_MS));
    }

    /** Small minimap frames need no extra round trip; large frames use the same immutable cache. */
    JSONObject offerIfLarge(JSONObject image, String instanceId, String sessionId, long generation) throws Exception {
        session.authorize(instanceId, sessionId, generation, false);
        if (image.getString("base64").length() > CHUNK_CHARS) return offer(image, instanceId, sessionId, generation);
        metadata(image);
        clear();
        return image;
    }

    private JSONObject metadata(JSONObject image) throws Exception {
        String base64 = image.getString("base64"), mime = image.getString("mime");
        if ((!mime.equals("image/png") && !mime.equals("image/jpeg")) || base64.isEmpty()
                || base64.length() > MAX_CHARS || base64.length() % 4 != 0)
            throw new IllegalArgumentException("截图数据超出传输范围");
        int width = image.getInt("width"), height = image.getInt("height");
        if (width <= 0 || height <= 0 || width > 20000 || height > 20000)
            throw new IllegalArgumentException("截图原始尺寸无效");
        JSONObject metadata = new JSONObject().put("mime", mime).put("width", width).put("height", height);
        if (image.has("region")) {
            ScreenshotRegion region = ScreenshotRegion.from(image.getJSONObject("region"));
            region.requireWithin(width, height); metadata.put("region", region.toJson());
        }
        return metadata;
    }

    JSONObject read(String instanceId, String sessionId, long generation, String transferId, int offset) throws Exception {
        prune();
        session.authorize(instanceId, sessionId, generation, false);
        Entry value = entry;
        if (value == null || !value.id.equals(transferId) || !value.instanceId.equals(instanceId)
                || !value.sessionId.equals(sessionId) || value.generation != generation)
            throw new IllegalStateException("截图传输已结束或过期，请重新获取画面");
        if (offset < 0 || offset >= value.base64.length() || offset % CHUNK_CHARS != 0)
            throw new IllegalArgumentException("截图分块位置无效");
        int end = Math.min(value.base64.length(), offset + CHUNK_CHARS);
        JSONObject result = new JSONObject().put("id", value.id).put("offset", offset)
            .put("base64", value.base64.substring(offset, end)).put("done", end == value.base64.length());
        if (end == value.base64.length()) clear();
        return result;
    }

    void prune() {
        session.expire();
        if (entry != null && (clock.getAsLong() - entry.at >= TTL_MS || !session.active()
                || !entry.instanceId.equals(session.instanceId) || !entry.sessionId.equals(session.sessionId)
                || entry.generation != session.generation)) clear();
    }
    void clear() { entry = null; }
}
