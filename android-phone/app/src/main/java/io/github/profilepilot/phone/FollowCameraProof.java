package io.github.profilepilot.phone;

import java.util.Objects;
import org.json.JSONObject;

/** Main-looper state for id 1 only. Receiving a command is not applying a gesture. */
final class FollowCameraProof {
    record Point(int x, int y) { }
    record Request(long epoch, Point point) { }
    record Snapshot(long epoch, long sequence, Point point, long heldSince, long expires, long observedAt) { }
    private long epoch, sequence, heldSince, expires;
    private Point desired, applied;

    void request(long sequence, Point point, long expires, long now) {
        expire(now);
        if (!Objects.equals(desired, point)) { epoch++; applied = null; }
        desired = point; this.sequence = sequence; this.expires = expires;
    }
    Request request() { return new Request(epoch, desired); }
    void applied(Request request, Point held, long now) {
        expire(now);
        if (request.epoch != epoch || desired == null || !desired.equals(held) || !desired.equals(request.point)) return;
        if (applied == null) heldSince = now;
        applied = held;
    }
    void invalidate() { epoch++; desired = null; applied = null; expires = 0; }
    private void expire(long now) { if (expires != 0 && now >= expires) invalidate(); }
    Snapshot snapshot(long now) {
        expire(now);
        return applied == null || sequence <= 0 ? null : new Snapshot(epoch, sequence, applied, heldSince, expires, now);
    }
    JSONObject captured(Snapshot before, long capturedAt, long now) throws Exception {
        Snapshot after = snapshot(now);
        // Both sides of the capture callback must prove the same applied hold.
        // Use the screenshot's own uptime, not encode/HTTP completion time.
        if (before == null || after == null || before.epoch != after.epoch || before.sequence != after.sequence
                || !before.point.equals(after.point) || before.heldSince != after.heldSince
                || capturedAt < before.observedAt || capturedAt < before.heldSince || capturedAt > now
                || capturedAt >= before.expires || capturedAt >= after.expires) return null;
        return new JSONObject().put("version", 1).put("epoch", before.epoch).put("sequence", before.sequence)
            .put("x", before.point.x).put("y", before.point.y).put("heldSinceUptimeMs", before.heldSince)
            .put("capturedAtUptimeMs", capturedAt).put("expiresAtUptimeMs", before.expires);
    }
}
