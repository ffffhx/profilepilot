package io.github.profilepilot.phone;

import org.junit.Test;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;
import static org.junit.Assert.*;

public class DebuggingSetupTest {
    private DebuggingSetup.Node node(int parent, String text, String id, boolean toggle, boolean checked, boolean enabled, boolean clickable) {
        return new DebuggingSetup.Node(parent, text, id, toggle, checked, enabled, clickable);
    }
    private List<DebuggingSetup.Node> colorOs(boolean checked) {
        // Root contains separate USB and wireless preferences, each with a split switch target.
        return new ArrayList<>(List.of(
            node(-1, "", "", false, false, true, false),
            node(0, "", "", false, false, true, true),
            node(1, "USB 调试", "android:id/title", false, false, true, false),
            node(1, "", "android:id/switch_widget", true, true, true, true),
            node(0, "", "", false, false, true, true),
            node(4, "", "com.android.settings:id/main_layout", false, false, true, true),
            node(5, "无线调试", "android:id/title", false, false, true, false),
            node(4, "", "com.android.settings:id/switch_layout", false, false, true, true),
            node(7, "关闭", "android:id/switch_widget", true, checked, true, false)));
    }
    @Test public void splitPreferenceClicksSwitchContainerNotTitleOrUsb() {
        assertEquals(7, DebuggingSetup.target(colorOs(false), DebuggingSetup.Setting.WIRELESS));
    }
    @Test public void usbRequestSelectsOnlyUsbEvenWhenWirelessIsAlsoOff() {
        List<DebuggingSetup.Node> nodes = colorOs(false);
        nodes.set(3, node(1, "关闭", "android:id/switch_widget", true, false, true, true));
        assertEquals(3, DebuggingSetup.target(nodes, DebuggingSetup.Setting.USB));
        assertEquals(7, DebuggingSetup.target(nodes, DebuggingSetup.Setting.WIRELESS));
    }
    @Test public void enabledUsbNeverFallsThroughToDisabledWireless() {
        assertEquals(DebuggingSetup.ALREADY_ENABLED, DebuggingSetup.target(colorOs(false), DebuggingSetup.Setting.USB));
        List<DebuggingSetup.Node> nodes = colorOs(false);
        nodes.set(2, node(1, "安装验证", "android:id/title", false, false, true, false));
        assertEquals(-1, DebuggingSetup.target(nodes, DebuggingSetup.Setting.USB));
    }
    @Test public void usbAuthorizationDialogStopsAllAutomation() {
        List<DebuggingSetup.Node> nodes = colorOs(false);
        nodes.set(3, node(1, "关闭", "android:id/switch_widget", true, false, true, true));
        nodes.add(node(0, "允许", "android:id/button1", false, false, true, true));
        assertEquals(-1, DebuggingSetup.target(nodes, DebuggingSetup.Setting.USB));
    }
    @Test public void enabledWirelessSwitchIsNeverTurnedOff() {
        assertEquals(DebuggingSetup.ALREADY_ENABLED, DebuggingSetup.target(colorOs(true), DebuggingSetup.Setting.WIRELESS));
    }
    @Test public void systemConfirmationIsNeverAccepted() {
        List<DebuggingSetup.Node> nodes = colorOs(false);
        nodes.add(node(0, "允许", "android:id/button1", false, false, true, true));
        assertTrue(DebuggingSetup.dialog(nodes));
        assertEquals(-1, DebuggingSetup.target(nodes, DebuggingSetup.Setting.WIRELESS));
    }
    @Test public void missingWirelessSwitchCannotResolveToNeighboringSwitch() {
        List<DebuggingSetup.Node> nodes = colorOs(false);
        nodes.remove(8);
        assertEquals(-1, DebuggingSetup.target(nodes, DebuggingSetup.Setting.WIRELESS));
    }
    @Test public void duplicateLabelsAndDisabledSwitchAreRejected() {
        List<DebuggingSetup.Node> nodes = colorOs(false);
        nodes.add(node(4, "无线调试", "android:id/title", false, false, true, false));
        assertEquals(-1, DebuggingSetup.target(nodes, DebuggingSetup.Setting.WIRELESS));
        nodes = colorOs(false);
        nodes.set(8, node(7, "", "android:id/switch_widget", true, false, false, false));
        assertEquals(-1, DebuggingSetup.target(nodes, DebuggingSetup.Setting.WIRELESS));
    }
    @Test public void standardPreferenceCanClickItsSwitchDirectly() {
        List<DebuggingSetup.Node> nodes = colorOs(false);
        nodes.set(6, node(5, "Wireless debugging", "android:id/title", false, false, true, false));
        nodes.set(8, node(7, "", "android:id/switch_widget", true, false, true, true));
        assertEquals(8, DebuggingSetup.target(nodes, DebuggingSetup.Setting.WIRELESS));
    }
    private SessionState session(AtomicLong clock, String mode) {
        SessionState state = new SessionState(clock::get);
        state.start(state.instanceId, 0, UUID.randomUUID().toString(), mode, "pc", "agent", "setup", 1);
        return state;
    }
    @Test public void aClickCanOnlyBeConsumedOnce() {
        SessionState session = session(new AtomicLong(1), "control");
        DebuggingSetup.Request request = new DebuggingSetup.Request(session, 1);
        assertTrue(request.consume(session, 100, true));
        assertFalse(request.consume(session, 101, true));
    }
    @Test public void pauseThenResumeCannotReviveDeferredClick() {
        SessionState session = session(new AtomicLong(1), "control");
        DebuggingSetup.Request request = new DebuggingSetup.Request(session, 1);
        session.pause("user takeover");
        assertFalse(request.valid(session, 100, true));
        session.resume();
        assertFalse(request.consume(session, 101, true));
    }
    @Test public void stopDisconnectViewAndReplacementRejectDeferredInput() {
        AtomicLong clock = new AtomicLong(1);
        SessionState session = session(clock, "control");
        DebuggingSetup.Request request = new DebuggingSetup.Request(session, 1);
        session.stop("done");
        assertFalse(request.valid(session, 100, true));
        session = session(clock, "control");
        request = new DebuggingSetup.Request(session, 1);
        clock.set(9000);
        assertFalse(request.valid(session, 100, true));
        session = session(clock, "view");
        assertFalse(new DebuggingSetup.Request(session, 1).valid(session, 100, true));
        session = session(clock, "control");
        request = new DebuggingSetup.Request(session, 1);
        assertFalse(request.valid(session(clock, "control"), 100, true));
        assertFalse(request.valid(null, 100, true));
    }
    @Test public void localSetupNeedsNoComputerAndExpiresOrCancelsOnLock() {
        DebuggingSetup.Request request = new DebuggingSetup.Request(null, 1);
        assertTrue(request.valid(null, 100, true));
        assertFalse(request.valid(null, 100, false));
        assertFalse(request.valid(null, 6001, true));
        SessionState paused = session(new AtomicLong(1), "control");
        paused.pause("user");
        request = new DebuggingSetup.Request(paused, 1);
        assertTrue(request.consume(paused, 100, true));
        assertEquals("paused", paused.phase); // A local shortcut never resumes remote control.
    }
}
