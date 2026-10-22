package io.github.profilepilot.phone;

import static org.junit.Assert.*;
import android.app.Instrumentation;
import android.app.UiAutomation;
import android.content.Intent;
import android.os.SystemClock;
import android.view.MotionEvent;
import android.view.View;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
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
    @Test public void cameraPointerSurvivesJoystickChangesAndBothReleaseOnExpiryOrRevocation() throws Exception {
        instrumentation.getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
        long deadline = SystemClock.elapsedRealtime() + 60000;
        while (PhoneAccessibility.current == null && SystemClock.elapsedRealtime() < deadline) SystemClock.sleep(50);
        assertNotNull(PhoneAccessibility.current);
        AtomicReference<FollowTouch> touch = new AtomicReference<>();
        AtomicReference<View> surface = new AtomicReference<>();
        AtomicBoolean authorized = new AtomicBoolean(true);
        AtomicInteger active = new AtomicInteger(), maximum = new AtomicInteger(), cancels = new AtomicInteger();
        try (ActivityScenario<ControlBenchmarkActivity> activity = ActivityScenario.launch(
                new Intent(instrumentation.getTargetContext(), ControlBenchmarkActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))) {
            activity.onActivity(a -> {
                View view = new View(a); view.setBackgroundColor(android.graphics.Color.DKGRAY);
                view.setOnTouchListener((v, event) -> {
                    maximum.set(Math.max(maximum.get(), event.getPointerCount()));
                    int action = event.getActionMasked();
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
                touch.get().update(new JSONArray().put(finger(1, cx, cy)), 1200, authorized::get, 1);
                assertNull("Receipt must not claim applied camera", touch.get().cameraSnapshot());
            });
            SystemClock.sleep(250); assertEquals(1, active.get());
            AtomicReference<FollowCameraProof.Snapshot> first = new AtomicReference<>();
            main(() -> { first.set(touch.get().cameraSnapshot()); assertNotNull(first.get()); });
            main(() -> touch.get().update(new JSONArray().put(finger(0, jx, jy)).put(finger(1, cx, cy)), 1200, authorized::get, 2));
            SystemClock.sleep(250); assertEquals(2, active.get()); assertEquals(2, maximum.get());
            main(() -> touch.get().update(new JSONArray().put(finger(0, jx + 50, jy)).put(finger(1, cx, cy)), 1200, authorized::get, 3));
            SystemClock.sleep(250); assertEquals(2, active.get());
            main(() -> {
                var proof = touch.get().cameraSnapshot(); assertNotNull(proof);
                assertEquals(first.get().epoch(), proof.epoch()); assertEquals(first.get().heldSince(), proof.heldSince());
                assertEquals(3, proof.sequence());
                touch.get().update(new JSONArray().put(finger(1, cx, cy)), 1200, authorized::get, 4);
            });
            SystemClock.sleep(250); assertEquals("Dropping joystick must preserve camera", 1, active.get());
            main(() -> { assertNotNull(touch.get().cameraSnapshot()); touch.get().release(); assertNull(touch.get().cameraSnapshot()); });
            SystemClock.sleep(250); assertEquals(0, active.get());
            main(() -> touch.get().update(new JSONArray().put(finger(0, jx, jy)).put(finger(1, cx, cy)), 200, authorized::get, 5));
            SystemClock.sleep(500); assertEquals("Both pointers expire without another command", 0, active.get());
            main(() -> { assertFalse(touch.get().active()); assertNull(touch.get().cameraSnapshot()); });
            main(() -> touch.get().update(new JSONArray().put(finger(0, jx, jy)).put(finger(1, cx, cy)), 1200, authorized::get, 6));
            SystemClock.sleep(250); assertEquals(2, active.get()); authorized.set(false);
            SystemClock.sleep(250); assertEquals(0, active.get()); assertEquals(0, cancels.get());
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
        AtomicReference<Float> lastX = new AtomicReference<>(0f);
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
                    lastX.set(event.getRawX()); return true;
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
            main(() -> touch.get().update(point(x + 50, y, x), 1200, authorized::get));
            SystemClock.sleep(250);
            assertEquals(x + 50, lastX.get(), 2f); assertEquals(1, downs.get());
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
