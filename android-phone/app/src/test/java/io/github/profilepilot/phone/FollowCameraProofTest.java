package io.github.profilepilot.phone;

import static org.junit.Assert.*;
import org.json.JSONObject;
import org.junit.Test;

public class FollowCameraProofTest {
    private final FollowCameraProof camera = new FollowCameraProof();
    private final FollowCameraProof.Point a = new FollowCameraProof.Point(340, 210), b = new FollowCameraProof.Point(370, 230);
    private void held() { camera.request(1, a, 1300, 100); camera.applied(camera.request(), a, 180); }

    @Test public void receiptDoesNotProveApplicationAndCaptureMustFollowIt() throws Exception {
        camera.request(1, a, 1300, 100);
        assertNull(camera.snapshot(110));
        camera.applied(camera.request(), a, 180);
        var before = camera.snapshot(200);
        assertNull(camera.captured(before, 179, 220));
        assertNull(camera.captured(before, 199, 220));
        assertNull(camera.captured(before, 221, 220));
        JSONObject proof = camera.captured(before, 210, 220);
        assertEquals(180, proof.getLong("heldSinceUptimeMs"));
        assertEquals(210, proof.getLong("capturedAtUptimeMs"));
        assertEquals(1300, proof.getLong("expiresAtUptimeMs"));
        assertEquals(1, proof.getLong("sequence"));
    }
    @Test public void renewalAndJoystickOnlyChangesKeepCameraEpochAndStartTime() throws Exception {
        held(); var original = camera.snapshot(200);
        camera.request(2, a, 1700, 500);
        // The already-applied id 1 is unchanged even if id 0 is being moved.
        camera.applied(camera.request(), a, 580);
        var next = camera.snapshot(600);
        assertEquals(original.epoch(), next.epoch()); assertEquals(180, next.heldSince());
        assertEquals(2, next.sequence()); assertEquals(1700, next.expires());
        assertNull(camera.captured(original, 510, 600));
        assertNotNull(camera.captured(next, 610, 620));
    }
    @Test public void movingOrRemovingCameraInvalidatesBeforeGestureCompletion() throws Exception {
        held(); var before = camera.snapshot(200);
        camera.request(2, b, 1500, 300); var move = camera.request();
        assertNull(camera.snapshot(310)); assertNull(camera.captured(before, 305, 310));
        camera.applied(move, b, 380);
        var moved = camera.snapshot(400);
        assertNotEquals(before.epoch(), moved.epoch()); assertEquals(380, moved.heldSince());
        camera.request(3, null, 1700, 500);
        assertNull(camera.captured(moved, 490, 510));
    }
    @Test public void oldCallbacksCannotRestoreCancelledOrSupersededCamera() throws Exception {
        camera.request(1, a, 1300, 100); var first = camera.request();
        camera.request(2, b, 1400, 200);
        camera.applied(first, a, 250); assertNull(camera.snapshot(260));
        var second = camera.request(); camera.invalidate();
        camera.applied(second, b, 300); assertNull(camera.snapshot(310));
        camera.request(3, b, 1600, 400);
        camera.applied(second, b, 450); assertNull(camera.snapshot(460));
        camera.applied(camera.request(), b, 480); assertNotNull(camera.snapshot(490));
    }
    @Test public void expiryCannotBeHiddenByLateRenewalOrDelayedScreenshotCallback() throws Exception {
        held(); var before = camera.snapshot(1200);
        assertNull(camera.captured(before, 1250, 1300));
        camera.request(2, a, 2600, 1400);
        assertNull(camera.snapshot(1410));
        camera.applied(camera.request(), a, 1480);
        var next = camera.snapshot(1500);
        assertNotEquals(before.epoch(), next.epoch()); assertEquals(1480, next.heldSince());
        assertNull(camera.captured(before, 1250, 1510));
    }
    @Test public void absentCameraAndWrongAppliedCoordinatesNeverProduceProof() throws Exception {
        camera.request(1, null, 1300, 100);
        camera.applied(camera.request(), null, 180); assertNull(camera.snapshot(200));
        camera.request(2, a, 1500, 300);
        camera.applied(camera.request(), b, 380); assertNull(camera.snapshot(400));
        camera.applied(camera.request(), a, 1500); assertNull(camera.snapshot(1501));
    }
    @Test public void changingPointRequiresNewDownAfterCameraUpEvenIfJoystickContinues() throws Exception {
        held(); var before = camera.snapshot(200);
        camera.request(2, b, 1500, 300); var change = camera.request();
        // First dispatch ends only camera id 1. Completing id 0's continuation
        // cannot attest the replacement camera while there is no held id 1.
        camera.applied(change, null, 380);
        assertNull(camera.snapshot(390)); assertNull(camera.captured(before, 385, 390));
        camera.applied(change, b, 460);
        var after = camera.snapshot(470);
        assertEquals(before.epoch() + 1, after.epoch()); assertEquals(460, after.heldSince());
        assertNotNull(camera.captured(after, 480, 490));
    }
    @Test public void updatesDuringCameraUpDoNotProveOrRestoreSupersededDown() throws Exception {
        held(); camera.request(2, b, 1500, 300); var previous = camera.request();
        camera.request(3, a, 1550, 350); var latest = camera.request();
        camera.applied(previous, null, 380); assertNull(camera.snapshot(390));
        camera.applied(previous, b, 460); assertNull(camera.snapshot(470));
        camera.applied(latest, a, 540);
        var proof = camera.snapshot(550); assertEquals(3, proof.sequence()); assertEquals(540, proof.heldSince());
        camera.request(4, null, 1700, 560);
        camera.applied(latest, a, 600); assertNull(camera.snapshot(610));
    }
    @Test public void samePointRenewalDuringRepressDoesNotShortcutDownOrExtendAppliedTime() throws Exception {
        held(); camera.request(2, b, 1500, 300); var change = camera.request();
        camera.request(3, b, 1550, 350);
        camera.applied(change, null, 380); assertNull(camera.snapshot(390));
        camera.applied(change, b, 460);
        var proof = camera.snapshot(470); assertEquals(3, proof.sequence()); assertEquals(460, proof.heldSince());
        camera.request(4, a, 600, 500); var expiring = camera.request();
        camera.applied(expiring, null, 580); assertNull(camera.snapshot(590));
        camera.applied(expiring, a, 660); assertNull(camera.snapshot(670));
    }
}
