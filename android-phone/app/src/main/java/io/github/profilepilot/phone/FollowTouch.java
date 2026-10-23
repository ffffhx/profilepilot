package io.github.profilepilot.phone;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.graphics.Path;
import android.graphics.Rect;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.BooleanSupplier;

/** Bounded, continuously held strokes. All access is confined to the main looper. */
final class FollowTouch {
    static final String CAMERA_POINT_CHANGE = "release-newdown";
    static final int CAMERA_REPRESS_GAP_MS = 100;
    private static final String TAG = "PPFollowTouch";
    private static final int STROKE_MS = 80;
    private record Point(float x, float y, float fromX, float fromY) { }
    private record Held(GestureDescription.StrokeDescription stroke, float x, float y) { }
    private final AccessibilityService service;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Runnable advance = this::step;
    private final Map<Integer, Held> held = new LinkedHashMap<>();
    private Map<Integer, Point> desired = new LinkedHashMap<>();
    private BooleanSupplier authorized = () -> false;
    private long expires;
    private boolean inFlight;
    private String error = "";
    private final FollowCameraProof camera = new FollowCameraProof();
    private long sequence;
    private long dispatchSequence;
    private long cameraDownNotBefore;
    FollowTouch(AccessibilityService service) { this.service = service; }
    void update(JSONArray points, int ttlMs, BooleanSupplier authorized) throws Exception {
        update(points, ttlMs, authorized, sequence + 1);
    }
    void update(JSONArray points, int ttlMs, BooleanSupplier authorized, long sequence) throws Exception {
        if (!error.isEmpty()) throw new IllegalStateException(error);
        if (ttlMs < 100 || ttlMs > 1500 || points.length() > 5) throw new IllegalArgumentException("持续触控参数无效");
        Rect bounds = service.getSystemService(android.view.WindowManager.class).getMaximumWindowMetrics().getBounds();
        Map<Integer, Point> next = new LinkedHashMap<>();
        for (int i = 0; i < points.length(); i++) {
            JSONObject p = points.getJSONObject(i);
            int id = p.getInt("id");
            if (id < 0 || id > 4 || next.containsKey(id)) throw new IllegalArgumentException("触点编号无效");
            float x = coordinate(p, "x", bounds.width()), y = coordinate(p, "y", bounds.height());
            float fromX = p.has("fromX") ? coordinate(p, "fromX", bounds.width()) : x;
            float fromY = p.has("fromY") ? coordinate(p, "fromY", bounds.height()) : y;
            next.put(id, new Point(x, y, fromX, fromY));
        }
        this.authorized = authorized;
        if (!authorized.getAsBoolean()) throw new IllegalStateException("手机会话已改变");
        long now = SystemClock.uptimeMillis();
        desired = next; expires = now + ttlMs; this.sequence = sequence;
        Point cameraPoint = next.get(1);
        camera.request(sequence, cameraPoint == null ? null : new FollowCameraProof.Point((int) cameraPoint.x, (int) cameraPoint.y), expires, now);
        if (!inFlight) step();
    }
    private static float coordinate(JSONObject p, String key, int limit) throws Exception {
        double value = p.getDouble(key);
        if (!Double.isFinite(value) || value < 0 || value >= limit) throw new IllegalArgumentException("触点超出屏幕");
        // Android rounds gesture coordinates to pixels. Keep our held position
        // in the same space so a subpixel update cannot become an empty gesture.
        return Math.min(limit - 1, Math.round((float) value));
    }
    static GestureDescription.StrokeDescription newStroke(Path path, boolean continuing) {
        int startMs = continuing ? 1 : 0;
        return new GestureDescription.StrokeDescription(path, startMs, STROKE_MS - startMs, true);
    }
    void release() {
        if (active()) trace("release", "requested");
        camera.invalidate(); desired.clear(); expires = 0; if (!inFlight) step();
    }
    private void trace(String event, String detail) {
        if (BuildConfig.DEBUG) Log.d(TAG, "event=" + event + " sequence=" + sequence
            + " dispatch=" + dispatchSequence + " held=" + held.keySet() + " desired=" + desired.keySet()
            + " inFlight=" + inFlight + " remainingMs=" + Math.max(0, expires - SystemClock.uptimeMillis()) + " " + detail);
    }
    FollowCameraProof.Snapshot cameraSnapshot() {
        if (!authorized.getAsBoolean()) { camera.invalidate(); return null; }
        return camera.snapshot(SystemClock.uptimeMillis());
    }
    JSONObject cameraCaptured(FollowCameraProof.Snapshot before, long capturedAt) throws Exception {
        if (!authorized.getAsBoolean()) { camera.invalidate(); return null; }
        return camera.captured(before, capturedAt, SystemClock.uptimeMillis());
    }
    private FollowCameraProof.Point cameraPoint(Map<Integer, Held> points) {
        Held point = points.get(1);
        return point == null ? null : new FollowCameraProof.Point((int) point.x, (int) point.y);
    }
    boolean active() { return inFlight || !held.isEmpty() || !desired.isEmpty(); }
    private void step() {
        main.removeCallbacks(advance);
        long now = SystemClock.uptimeMillis();
        boolean allowed = authorized.getAsBoolean();
        if (!allowed || now >= expires) {
            if (!desired.isEmpty()) trace("release", allowed ? "expired" : "authorization_revoked");
            camera.invalidate(); desired.clear();
        }
        if (desired.isEmpty() && held.isEmpty()) return;
        // The target game may process an immediate UP/DOWN as a camera release.
        // Wait after the UP completion callback (later than injection), while
        // continuing every other finger. Keep only a time gate, never a queued
        // point: each wake/update re-reads the latest desired map, owner and TTL.
        long cameraWait = !held.containsKey(1) && desired.containsKey(1) ? Math.max(0, cameraDownNotBefore - now) : 0;
        Map<Integer, Point> effective = desired;
        if (cameraWait > 0) { effective = new LinkedHashMap<>(desired); effective.remove(1); }
        boolean changed = !held.keySet().equals(effective.keySet());
        for (Map.Entry<Integer, Held> entry : held.entrySet()) {
            Point point = effective.get(entry.getKey());
            if (point != null && (point.x != entry.getValue().x || point.y != entry.getValue().y)) changed = true;
        }
        if (!changed) {
            camera.applied(camera.request(), cameraPoint(held), SystemClock.uptimeMillis());
            // A continued pointer stays down between gestures. A stationary
            // continuation has no DOWN, MOVE or UP event, so Android rejects it.
            // Keep the previous stroke and still check authorization/TTL often.
            long wait = cameraWait > 0 ? Math.min(STROKE_MS, cameraWait) : STROKE_MS;
            main.postDelayed(advance, Math.max(1, Math.min(wait, expires - now)));
            return;
        }
        GestureDescription.Builder builder = new GestureDescription.Builder();
        Map<Integer, Held> next = new LinkedHashMap<>();
        Held oldCamera = held.get(1);
        Point wantedCamera = effective.get(1);
        // The game can ignore short camera MOVE strokes even when Android
        // completes them. End only id 1 first; its replacement is added by the
        // next step after this UP completes. Other held fingers remain continuous.
        boolean repressCamera = oldCamera != null && wantedCamera != null
            && (oldCamera.x != wantedCamera.x || oldCamera.y != wantedCamera.y);
        for (Map.Entry<Integer, Held> entry : held.entrySet()) {
            Held old = entry.getValue();
            Point point = repressCamera && entry.getKey() == 1 ? null : effective.get(entry.getKey());
            Path path = new Path(); path.moveTo(old.x, old.y);
            float x = point == null ? old.x : point.x, y = point == null ? old.y : point.y;
            path.lineTo(x, y);
            GestureDescription.StrokeDescription stroke = old.stroke.continueStroke(path, 0, STROKE_MS, point != null);
            builder.addStroke(stroke);
            if (point != null) next.put(entry.getKey(), new Held(stroke, x, y));
        }
        // MotionEventInjector.prepareToContinueOldGesture requires the FIRST
        // gesture step to contain exactly the previously held pointers. A new
        // pointer at time 0 makes that continuation fail and cancels every finger.
        // A 1 ms start is a GestureDescription key point (not rounded to the
        // sampling interval), so additions follow the old-only initial step.
        // Keep the same 80 ms end time and leave fresh/single-pointer starts alone.
        int newStartMs = held.isEmpty() ? 0 : 1;
        int additions = 0;
        for (Map.Entry<Integer, Point> entry : effective.entrySet()) {
            // During camera UP, held still contains id 1, so it cannot also be
            // added here. The completion callback re-reads the latest desired
            // map/authorization/TTL; it never queues a captured replacement point.
            if (held.containsKey(entry.getKey())) continue;
            Point point = entry.getValue();
            Path path = new Path();
            if (entry.getKey() == 1) path.moveTo(point.x, point.y);
            else path.moveTo(point.fromX, point.fromY);
            path.lineTo(point.x, point.y);
            GestureDescription.StrokeDescription stroke = newStroke(path, !held.isEmpty());
            builder.addStroke(stroke); next.put(entry.getKey(), new Held(stroke, point.x, point.y));
            additions++;
        }
        inFlight = true;
        long dispatched = ++dispatchSequence, dispatchedAt = SystemClock.uptimeMillis(), commandSequence = sequence;
        String cameraStage = repressCamera ? "release-for-change" : oldCamera == null && wantedCamera != null ? "fresh-down" : "unchanged-or-release";
        FollowCameraProof.Request cameraRequest = camera.request();
        trace("dispatch", "additions=" + additions + " newStartMs=" + newStartMs + " cameraStage=" + cameraStage
            + " cameraEpoch=" + cameraRequest.epoch() + " cameraPoint=" + (wantedCamera == null ? "none" : wantedCamera.x + "," + wantedCamera.y));
        boolean accepted = service.dispatchGesture(builder.build(), new AccessibilityService.GestureResultCallback() {
            @Override public void onCompleted(GestureDescription description) {
                trace("completed", "callbackDispatch=" + dispatched + " callbackSequence=" + commandSequence
                    + " cameraStage=" + cameraStage + " elapsedMs=" + (SystemClock.uptimeMillis() - dispatchedAt));
                if (oldCamera != null && !next.containsKey(1)) {
                    cameraDownNotBefore = SystemClock.uptimeMillis() + CAMERA_REPRESS_GAP_MS;
                    trace("camera-gap", "afterCallbackMs=" + CAMERA_REPRESS_GAP_MS + " downNotBeforeUptimeMs=" + cameraDownNotBefore);
                }
                inFlight = false; held.clear(); held.putAll(next);
                if (authorized.getAsBoolean()) camera.applied(cameraRequest, cameraPoint(next), SystemClock.uptimeMillis());
                else camera.invalidate();
                step();
            }
            @Override public void onCancelled(GestureDescription description) {
                // Android's public callback provides no cancellation reason.
                // Keep the actual callback and topology visible, without
                // attributing it to user input or a framework rule speculatively.
                trace("cancelled", "reason=system_callback_unspecified callbackDispatch=" + dispatched
                    + " elapsedMs=" + (SystemClock.uptimeMillis() - dispatchedAt));
                camera.invalidate(); inFlight = false; held.clear(); desired.clear();
                error = "持续触控被取消，已暂停；请重新开始跟随";
                if (ControlService.current != null) ControlService.current.localControl("pause");
            }
        }, main);
        if (!accepted) {
            trace("rejected", "reason=dispatch_returned_false");
            camera.invalidate(); inFlight = false; held.clear(); desired.clear();
            error = "系统未接受持续触控，已暂停";
            if (ControlService.current != null) ControlService.current.localControl("pause");
        }
    }
}
