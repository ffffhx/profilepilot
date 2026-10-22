package io.github.profilepilot.phone;

import static org.junit.Assert.*;
import android.app.Instrumentation;
import android.app.UiAutomation;
import android.content.Intent;
import android.graphics.BitmapFactory;
import android.graphics.Path;
import android.os.SystemClock;
import android.util.Base64;
import android.util.Log;
import android.view.MotionEvent;
import android.view.View;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.lang.reflect.Field;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Real gesture regression on an isolated debug fixture; never touches a user's app. */
@RunWith(AndroidJUnit4.class)
public class FollowTouchTest {
    private final Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
    private interface Operation { void run() throws Exception; }
    private void main(Operation operation) {
        instrumentation.runOnMainSync(() -> {
            try { operation.run(); } catch (Exception error) { throw new RuntimeException(error); }
        });
    }
    private JSONArray point(int x, int y, int fromX) throws Exception {
        return new JSONArray().put(new JSONObject().put("id", 0).put("x", x).put("y", y)
                .put("fromX", fromX).put("fromY", y));
    }
    private JSONObject finger(int id, int x, int y) throws Exception {
        return new JSONObject().put("id", id).put("x", x).put("y", y);
    }
    private record MotionSample(long at, float x, float y) { }
    /** Test-page samples, read and written on the main looper only. */
    private static final class EndpointTrace {
        MotionSample previous, actual, delivered;
        boolean hasHistory;
        void add(MotionEvent event) {
            delivered = new MotionSample(event.getEventTime(), event.getRawX(), event.getRawY());
            hasHistory = event.getHistorySize() > 0;
            float offsetX = event.getRawX() - event.getX(), offsetY = event.getRawY() - event.getY();
            for (int i = 0; i < event.getHistorySize(); i++) addActual(new MotionSample(event.getHistoricalEventTime(i),
                event.getHistoricalX(i) + offsetX, event.getHistoricalY(i) + offsetY));
            if (!hasHistory) addActual(delivered);
        }
        private void addActual(MotionSample sample) {
            if (actual == null || sample.at > actual.at) { previous = actual; actual = sample; }
        }
        void assertEndpoint(int fromX, int fromY, int x, int y, String trace) {
            assertNotNull(actual); assertNotNull(delivered);
            String message = "Endpoint current/history samples:\n" + trace;
            // Injection must still reach the requested endpoint within 2 px.
            assertEquals(message, x, actual.x, 2f); assertEquals(message, y, actual.y, 2f);
            if (Math.abs(delivered.x - x) <= 2 && Math.abs(delivered.y - y) <= 2) return;
            // Android 13 InputConsumer appends a VSYNC prediction to MOVE. Do
            // not accept arbitrary overshoot merely because history hit target:
            // require two real samples, its bounded future timestamp and the
            // corresponding linear prediction, also within 2 px on each axis.
            assertTrue(message, hasHistory); assertNotNull(message, previous);
            long delta = actual.at - previous.at, ahead = delivered.at - actual.at;
            assertTrue(message, delta >= 2 && delta <= 20);
            assertTrue(message, ahead > 0 && ahead <= Math.min(delta / 2.0, 8));
            // Both source samples must also agree with this commanded 80 ms
            // straight stroke, allowing one pixel of framework rounding.
            assertTrue(message, Math.abs(actual.x - previous.x) <= Math.abs(x - fromX) * delta / 80f + 1);
            assertTrue(message, Math.abs(actual.y - previous.y) <= Math.abs(y - fromY) * delta / 80f + 1);
            float predictedX = actual.x + (actual.x - previous.x) * ahead / delta;
            float predictedY = actual.y + (actual.y - previous.y) * ahead / delta;
            assertEquals(message, predictedX, delivered.x, 2f); assertEquals(message, predictedY, delivered.y, 2f);
            Log.i("PPFollowTouchTest", "stationary resampled endpoint actualX=" + actual.x + " deliveredX=" + delivered.x
                + " deviationX=" + (delivered.x - x) + " predictionMs=" + ahead + " sampleDeltaMs=" + delta);
        }
    }
    @Test public void newPointerStartsAfterContinuationButFreshGesturesStartImmediately() {
        Path path = new Path(); path.moveTo(100, 100); path.lineTo(150, 100);
        var fresh = FollowTouch.newStroke(path, false);
        var added = FollowTouch.newStroke(path, true);
        assertEquals(0, fresh.getStartTime()); assertEquals(80, fresh.getDuration());
        assertEquals(1, added.getStartTime()); assertEquals(79, added.getDuration());
        assertEquals(80, added.getStartTime() + added.getDuration());
        assertTrue(fresh.willContinue()); assertTrue(added.willContinue());
    }
    @Test public void nativeScreenshotProvesAppliedCameraAndReleaseRemovesProof() throws Exception {
        instrumentation.getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
        long deadline = SystemClock.elapsedRealtime() + 60000;
        while (PhoneAccessibility.current == null && SystemClock.elapsedRealtime() < deadline) SystemClock.sleep(50);
        PhoneAccessibility service = PhoneAccessibility.current;
        assertNotNull("Companion accessibility service must be connected", service);
        Field field = PhoneAccessibility.class.getDeclaredField("followTouch"); field.setAccessible(true);
        AtomicReference<FollowTouch> previous = new AtomicReference<>(), touch = new AtomicReference<>();
        AtomicBoolean authorized = new AtomicBoolean(true);
        AtomicReference<View> surface = new AtomicReference<>();
        try (ActivityScenario<ControlBenchmarkActivity> activity = ActivityScenario.launch(
                new Intent(instrumentation.getTargetContext(), ControlBenchmarkActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))) {
            activity.onActivity(a -> {
                View view = new View(a); view.setBackgroundColor(android.graphics.Color.DKGRAY);
                view.setOnTouchListener((v, event) -> true); a.setContentView(view); surface.set(view);
            });
            main(() -> {
                previous.set((FollowTouch) field.get(service));
                assertTrue("Fixture must not replace an active task", previous.get() == null || !previous.get().active());
                touch.set(new FollowTouch(service)); field.set(service, touch.get());
            });
            SystemClock.sleep(300);
            int[] origin = new int[2], size = new int[2];
            main(() -> { surface.get().getLocationOnScreen(origin); size[0] = surface.get().getWidth(); size[1] = surface.get().getHeight(); });
            assertTrue(size[0] > 300 && size[1] > 300);
            int cx = origin[0] + size[0] * 3 / 4, cy = origin[1] + size[1] / 4;
            main(() -> touch.get().update(new JSONArray().put(finger(1, cx, cy)), 1200, authorized::get, 1));
            SystemClock.sleep(300);
            AtomicReference<FollowCameraProof.Snapshot> before = new AtomicReference<>();
            AtomicReference<CompletableFuture<Object>> capture = new AtomicReference<>();
            long[] requestedAt = new long[1];
            main(() -> {
                touch.get().update(new JSONArray().put(finger(1, cx, cy)), 1200, authorized::get, 2);
                before.set(touch.get().cameraSnapshot()); assertNotNull(before.get());
                assertTrue(SystemClock.uptimeMillis() - before.get().heldSince() >= 250);
                requestedAt[0] = SystemClock.uptimeMillis();
                capture.set(service.perform(new JSONObject().put("kind", "screenshot").put("nativeSize", true).put("cameraFrameProvenance", 1)));
            });
            JSONObject frame = (JSONObject) capture.get().get(5, TimeUnit.SECONDS);
            long returnedAt = SystemClock.uptimeMillis();
            JSONObject proof = frame.getJSONObject("cameraProof");
            assertEquals(1, proof.getInt("version")); assertEquals(cx, proof.getInt("x")); assertEquals(cy, proof.getInt("y"));
            assertEquals(before.get().epoch(), proof.getLong("epoch")); assertEquals(2, proof.getLong("sequence"));
            assertEquals(before.get().heldSince(), proof.getLong("heldSinceUptimeMs"));
            assertEquals(before.get().expires(), proof.getLong("expiresAtUptimeMs"));
            long capturedAt = proof.getLong("capturedAtUptimeMs");
            assertTrue("ScreenshotResult timestamp must use phone uptime", capturedAt >= requestedAt[0] && capturedAt <= returnedAt);
            assertTrue(capturedAt >= before.get().heldSince() && capturedAt < before.get().expires());
            byte[] bytes = Base64.decode(frame.getString("base64"), Base64.DEFAULT);
            BitmapFactory.Options bounds = new BitmapFactory.Options(); bounds.inJustDecodeBounds = true;
            BitmapFactory.decodeByteArray(bytes, 0, bytes.length, bounds);
            assertEquals(frame.getInt("width"), bounds.outWidth); assertEquals(frame.getInt("height"), bounds.outHeight);
            Log.i("PPFollowTouchTest", "nativeProof epoch=" + proof.getLong("epoch") + " sequence=2 captureAgeMs=" + (returnedAt - capturedAt));
            main(() -> { touch.get().release(); assertNull(touch.get().cameraSnapshot()); });
            SystemClock.sleep(400);
            main(() -> capture.set(service.perform(new JSONObject().put("kind", "screenshot").put("nativeSize", true).put("cameraFrameProvenance", 1))));
            JSONObject released = (JSONObject) capture.get().get(5, TimeUnit.SECONDS);
            assertFalse("A new screenshot after release must carry no camera proof", released.has("cameraProof"));
        } finally {
            authorized.set(false);
            if (touch.get() != null) {
                main(() -> touch.get().release()); SystemClock.sleep(200);
                main(() -> { if (field.get(service) == touch.get()) field.set(service, previous.get()); });
            }
        }
    }
    @Test public void cameraPointerSurvivesJoystickChangesAndBothReleaseOnExpiryOrRevocation() throws Exception {
        instrumentation.getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
        long deadline = SystemClock.elapsedRealtime() + 60000;
        while (PhoneAccessibility.current == null && SystemClock.elapsedRealtime() < deadline) SystemClock.sleep(50);
        assertNotNull(PhoneAccessibility.current);
        AtomicReference<FollowTouch> touch = new AtomicReference<>();
        AtomicReference<View> surface = new AtomicReference<>();
        AtomicBoolean authorized = new AtomicBoolean(true);
        AtomicInteger active = new AtomicInteger(), maximum = new AtomicInteger(), cancels = new AtomicInteger(), downs = new AtomicInteger();
        AtomicInteger cameraPointer = new AtomicInteger(-1), cameraSamples = new AtomicInteger(), cameraPresses = new AtomicInteger();
        AtomicInteger cameraNextDownCount = new AtomicInteger();
        AtomicReference<Float> cameraMaximumError = new AtomicReference<>(0f);
        int[] cameraPosition = new int[2];
        try (ActivityScenario<ControlBenchmarkActivity> activity = ActivityScenario.launch(
                new Intent(instrumentation.getTargetContext(), ControlBenchmarkActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))) {
            activity.onActivity(a -> {
                View view = new View(a); view.setBackgroundColor(android.graphics.Color.DKGRAY);
                view.setOnTouchListener((v, event) -> {
                    maximum.set(Math.max(maximum.get(), event.getPointerCount()));
                    int action = event.getActionMasked();
                    if (action == MotionEvent.ACTION_DOWN) downs.incrementAndGet();
                    if ((action == MotionEvent.ACTION_DOWN || action == MotionEvent.ACTION_POINTER_DOWN)
                        && event.getPointerCount() == cameraNextDownCount.get()) {
                        int index = event.getActionIndex();
                        cameraPointer.set(event.getPointerId(index)); cameraNextDownCount.set(0); cameraPresses.incrementAndGet();
                    }
                    int cameraIndex = event.findPointerIndex(cameraPointer.get());
                    if (cameraIndex >= 0) {
                        cameraSamples.incrementAndGet();
                        cameraMaximumError.set(Math.max(cameraMaximumError.get(), Math.max(
                            Math.abs(event.getRawX(cameraIndex) - cameraPosition[0]), Math.abs(event.getRawY(cameraIndex) - cameraPosition[1]))));
                    }
                    if (action == MotionEvent.ACTION_CANCEL || action == MotionEvent.ACTION_UP
                        || action == MotionEvent.ACTION_POINTER_UP && event.getPointerId(event.getActionIndex()) == cameraPointer.get()) cameraPointer.set(-1);
                    if (action != MotionEvent.ACTION_MOVE) Log.i("PPFollowTouchTest", "action=" + MotionEvent.actionToString(event.getAction())
                        + " pointers=" + event.getPointerCount() + " changedId=" + event.getPointerId(event.getActionIndex()));
                    if (action == MotionEvent.ACTION_CANCEL) { cancels.incrementAndGet(); active.set(0); }
                    else active.set(action == MotionEvent.ACTION_UP ? 0
                        : event.getPointerCount() - (action == MotionEvent.ACTION_POINTER_UP ? 1 : 0));
                    return true;
                });
                a.setContentView(view); surface.set(view); touch.set(new FollowTouch(PhoneAccessibility.current));
            });
            SystemClock.sleep(300);
            int[] origin = new int[2], size = new int[2];
            main(() -> { surface.get().getLocationOnScreen(origin); size[0] = surface.get().getWidth(); size[1] = surface.get().getHeight(); });
            assertTrue(size[0] > 300 && size[1] > 300);
            int cx = origin[0] + size[0] * 3 / 4, cy = origin[1] + size[1] / 4;
            int jx = origin[0] + size[0] / 4, jy = origin[1] + size[1] * 3 / 4;
            main(() -> {
                cameraPosition[0] = cx; cameraPosition[1] = cy;
                cameraNextDownCount.set(1);
                touch.get().update(new JSONArray().put(finger(1, cx, cy)), 1200, authorized::get, 1);
                assertNull("Receipt must not claim applied camera", touch.get().cameraSnapshot());
            });
            SystemClock.sleep(250); assertEquals(1, active.get());
            AtomicReference<FollowCameraProof.Snapshot> first = new AtomicReference<>();
            main(() -> { first.set(touch.get().cameraSnapshot()); assertNotNull(first.get()); });
            main(() -> touch.get().update(new JSONArray().put(finger(0, jx, jy)).put(finger(1, cx, cy)), 1200, authorized::get, 2));
            SystemClock.sleep(250); assertEquals("Adding joystick must preserve the held camera", 2, active.get()); assertEquals(2, maximum.get());
            assertEquals("Adding a finger must not restart the gesture", 1, downs.get());
            main(() -> touch.get().update(new JSONArray().put(finger(0, jx + 50, jy)).put(finger(1, cx, cy)), 1200, authorized::get, 3));
            SystemClock.sleep(250); assertEquals(2, active.get());
            main(() -> {
                var proof = touch.get().cameraSnapshot(); assertNotNull(proof);
                assertEquals(first.get().epoch(), proof.epoch()); assertEquals(first.get().heldSince(), proof.heldSince());
                assertEquals(3, proof.sequence());
                touch.get().update(new JSONArray().put(finger(1, cx, cy)), 1200, authorized::get, 4);
            });
            SystemClock.sleep(250); assertEquals("Dropping joystick must preserve camera", 1, active.get());
            assertEquals(1, downs.get()); assertEquals(0, cancels.get());
            main(() -> { assertNotNull(touch.get().cameraSnapshot()); touch.get().release(); assertNull(touch.get().cameraSnapshot()); });
            SystemClock.sleep(250); assertEquals(0, active.get());
            // Also cover the opposite addition/removal order used when camera
            // assistance is armed while the joystick was already held.
            main(() -> touch.get().update(new JSONArray().put(finger(0, jx, jy)), 1200, authorized::get, 5));
            SystemClock.sleep(250); assertEquals(1, active.get());
            main(() -> {
                cameraNextDownCount.set(2);
                touch.get().update(new JSONArray().put(finger(0, jx, jy)).put(finger(1, cx, cy)), 1200, authorized::get, 6);
            });
            SystemClock.sleep(250); assertEquals("Adding camera must preserve joystick", 2, active.get());
            main(() -> touch.get().update(new JSONArray().put(finger(0, jx + 50, jy)), 1200, authorized::get, 7));
            SystemClock.sleep(250); assertEquals("Dropping camera must preserve joystick", 1, active.get());
            main(() -> { assertNull(touch.get().cameraSnapshot()); touch.get().release(); });
            SystemClock.sleep(250); assertEquals(0, active.get());
            main(() -> {
                cameraNextDownCount.set(2);
                touch.get().update(new JSONArray().put(finger(0, jx, jy)).put(finger(1, cx, cy)), 200, authorized::get, 8);
            });
            SystemClock.sleep(500); assertEquals("Both pointers expire without another command", 0, active.get());
            main(() -> { assertFalse(touch.get().active()); assertNull(touch.get().cameraSnapshot()); });
            main(() -> {
                cameraNextDownCount.set(2);
                touch.get().update(new JSONArray().put(finger(0, jx, jy)).put(finger(1, cx, cy)), 1200, authorized::get, 9);
            });
            SystemClock.sleep(250); assertEquals(2, active.get()); authorized.set(false);
            SystemClock.sleep(250); assertEquals(0, active.get()); assertEquals(0, cancels.get());
            assertTrue("Camera pointer must have been observed in the target View", cameraSamples.get() >= 8);
            assertEquals("Every camera press must be measured, without filtering by coordinate accuracy", 4, cameraPresses.get());
            assertTrue("Stationary camera must stay within 2px in delivered events, including joystick moves; maximum="
                + cameraMaximumError.get(), cameraMaximumError.get() <= 2);
            Log.i("PPFollowTouchTest", "camera deliveredSamples=" + cameraSamples.get() + " maximumErrorPx=" + cameraMaximumError.get());
            main(() -> assertNull(touch.get().cameraSnapshot()));
        } finally {
            authorized.set(false);
            if (touch.get() != null) { main(() -> touch.get().release()); SystemClock.sleep(200); }
        }
    }
    @Test public void stationaryHoldCanMoveReleaseExpireAndLoseAuthorization() throws Exception {
        // A non-waiting `am instrument` has no UiAutomation connection. The
        // test uses the companion's real accessibility service, not UiAutomation.
        // When a harness does supply it, leave that service enabled.
        instrumentation.getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
        // Starting instrumentation can restart the companion. The harness reconnects it;
        // this test never enables accessibility or changes device settings.
        long deadline = SystemClock.elapsedRealtime() + 60000;
        while (PhoneAccessibility.current == null && SystemClock.elapsedRealtime() < deadline) SystemClock.sleep(50);
        assertNotNull("Companion accessibility service must be connected", PhoneAccessibility.current);
        AtomicReference<FollowTouch> touch = new AtomicReference<>();
        AtomicBoolean authorized = new AtomicBoolean(true);
        AtomicInteger downs = new AtomicInteger(), ups = new AtomicInteger(), cancels = new AtomicInteger();
        EndpointTrace endpoint = new EndpointTrace();
        AtomicReference<String> eventTrace = new AtomicReference<>("");
        AtomicReference<View> surface = new AtomicReference<>();
        try (ActivityScenario<ControlBenchmarkActivity> activity = ActivityScenario.launch(
                new Intent(instrumentation.getTargetContext(), ControlBenchmarkActivity.class)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))) {
            activity.onActivity(a -> {
                View view = new View(a);
                view.setBackgroundColor(android.graphics.Color.DKGRAY);
                view.setOnTouchListener((v, event) -> {
                    switch (event.getActionMasked()) {
                        case MotionEvent.ACTION_DOWN -> downs.incrementAndGet();
                        case MotionEvent.ACTION_UP -> ups.incrementAndGet();
                        case MotionEvent.ACTION_CANCEL -> cancels.incrementAndGet();
                    }
                    endpoint.add(event);
                    // Keep actual samples when diagnosing platform batching or
                    // resampling. Do not relax endpoint accuracy on a guess.
                    StringBuilder sample = new StringBuilder("action=").append(MotionEvent.actionToString(event.getAction()))
                        .append(" time=").append(event.getEventTime()).append(" delivered=").append(SystemClock.uptimeMillis())
                        .append(" rawX=").append(event.getRawX()).append(" rawY=").append(event.getRawY()).append(" history=");
                    float offsetX = event.getRawX() - event.getX(), offsetY = event.getRawY() - event.getY();
                    for (int i = 0; i < event.getHistorySize(); i++) sample.append('[').append(event.getHistoricalEventTime(i))
                        .append(',').append(event.getHistoricalX(i) + offsetX).append(',').append(event.getHistoricalY(i) + offsetY).append(']');
                    String line = sample.toString(); Log.i("PPFollowTouchTest", "stationary " + line);
                    String trace = eventTrace.get() + line + "\n";
                    eventTrace.set(trace.substring(Math.max(0, trace.length() - 6000)));
                    return true;
                });
                a.setContentView(view); surface.set(view);
                touch.set(new FollowTouch(PhoneAccessibility.current));
            });
            SystemClock.sleep(300);
            int[] origin = new int[2], size = new int[2];
            main(() -> { surface.get().getLocationOnScreen(origin); size[0] = surface.get().getWidth(); size[1] = surface.get().getHeight(); });
            assertTrue(size[0] > 200 && size[1] > 200);
            int x = origin[0] + size[0] / 2, y = origin[1] + size[1] / 2;
            main(() -> touch.get().update(point(x, y, x - 80), 1200, authorized::get));
            SystemClock.sleep(600);
            main(() -> assertTrue("A stationary continued pointer must remain held", touch.get().active()));
            assertEquals(1, downs.get()); assertEquals(0, ups.get()); assertEquals(0, cancels.get());
            main(() -> {
                Log.i("PPFollowTouchTest", "stationary move requestedX=" + (x + 50) + " fromX=" + x + " uptime=" + SystemClock.uptimeMillis());
                touch.get().update(point(x + 50, y, x), 1200, authorized::get);
            });
            SystemClock.sleep(250);
            main(() -> endpoint.assertEndpoint(x, y, x + 50, y, eventTrace.get()));
            assertEquals(1, downs.get());
            main(() -> touch.get().release()); SystemClock.sleep(250);
            assertEquals(1, ups.get());
            main(() -> assertFalse(touch.get().active()));
            main(() -> touch.get().update(point(x, y, x - 80), 200, authorized::get));
            SystemClock.sleep(550);
            assertEquals("Expired command must release without another update", 2, ups.get());
            main(() -> assertFalse(touch.get().active()));
            main(() -> touch.get().update(point(x, y, x - 80), 1200, authorized::get));
            SystemClock.sleep(200); authorized.set(false); SystemClock.sleep(250);
            assertEquals("Revoked authorization must release", 3, ups.get());
            assertEquals(0, cancels.get());
            main(() -> assertFalse(touch.get().active()));
        } finally {
            authorized.set(false);
            if (touch.get() != null) { main(() -> touch.get().release()); SystemClock.sleep(200); }
        }
    }
}
