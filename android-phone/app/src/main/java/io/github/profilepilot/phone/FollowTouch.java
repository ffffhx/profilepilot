package io.github.profilepilot.phone;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.graphics.Path;
import android.graphics.Rect;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.BooleanSupplier;

/** Bounded, continuously held strokes. All access is confined to the main looper. */
final class FollowTouch {
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
    void release() { camera.invalidate(); desired.clear(); expires = 0; if (!inFlight) step(); }
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
        if (!authorized.getAsBoolean() || SystemClock.uptimeMillis() >= expires) { camera.invalidate(); desired.clear(); }
        if (desired.isEmpty() && held.isEmpty()) return;
        boolean changed = !held.keySet().equals(desired.keySet());
        for (Map.Entry<Integer, Held> entry : held.entrySet()) {
            Point point = desired.get(entry.getKey());
            if (point != null && (point.x != entry.getValue().x || point.y != entry.getValue().y)) changed = true;
        }
        if (!changed) {
            camera.applied(camera.request(), cameraPoint(held), SystemClock.uptimeMillis());
            // A continued pointer stays down between gestures. A stationary
            // continuation has no DOWN, MOVE or UP event, so Android rejects it.
            // Keep the previous stroke and still check authorization/TTL often.
            main.postDelayed(advance, 80);
            return;
        }
        GestureDescription.Builder builder = new GestureDescription.Builder();
        Map<Integer, Held> next = new LinkedHashMap<>();
        for (Map.Entry<Integer, Held> entry : held.entrySet()) {
            Held old = entry.getValue();
            Point point = desired.get(entry.getKey());
            Path path = new Path(); path.moveTo(old.x, old.y);
            float x = point == null ? old.x : point.x, y = point == null ? old.y : point.y;
            path.lineTo(x, y);
            GestureDescription.StrokeDescription stroke = old.stroke.continueStroke(path, 0, 80, point != null);
            builder.addStroke(stroke);
            if (point != null) next.put(entry.getKey(), new Held(stroke, x, y));
        }
        for (Map.Entry<Integer, Point> entry : desired.entrySet()) {
            if (held.containsKey(entry.getKey())) continue;
            Point point = entry.getValue();
            Path path = new Path(); path.moveTo(point.fromX, point.fromY); path.lineTo(point.x, point.y);
            GestureDescription.StrokeDescription stroke = new GestureDescription.StrokeDescription(path, 0, 80, true);
            builder.addStroke(stroke); next.put(entry.getKey(), new Held(stroke, point.x, point.y));
        }
        inFlight = true;
        FollowCameraProof.Request cameraRequest = camera.request();
        boolean accepted = service.dispatchGesture(builder.build(), new AccessibilityService.GestureResultCallback() {
            @Override public void onCompleted(GestureDescription description) {
                inFlight = false; held.clear(); held.putAll(next);
                if (authorized.getAsBoolean()) camera.applied(cameraRequest, cameraPoint(next), SystemClock.uptimeMillis());
                else camera.invalidate();
                step();
            }
            @Override public void onCancelled(GestureDescription description) {
                camera.invalidate(); inFlight = false; held.clear(); desired.clear();
                error = "持续触控被取消，已暂停；请重新开始跟随";
                if (ControlService.current != null) ControlService.current.localControl("pause");
            }
        }, main);
        if (!accepted) {
            camera.invalidate(); inFlight = false; held.clear(); desired.clear();
            error = "系统未接受持续触控，已暂停";
            if (ControlService.current != null) ControlService.current.localControl("pause");
        }
    }
}
