package io.github.profilepilot.phone;

import org.junit.Test;
import static org.junit.Assert.*;

public class ConnectionStateTest {
    @Test public void unobservedAndExpiredConnectionsAreNotReportedAsOnline() {
        long[] now = {0};
        ConnectionState state = new ConnectionState(() -> now[0]);
        assertFalse(state.connected());
        state.heartbeat("usb");
        assertTrue(state.connected("usb"));
        now[0] = SessionState.LEASE_MS;
        assertFalse(state.connected("usb"));
        assertFalse(state.connected());
    }

    @Test public void wirelessHeartbeatDoesNotKeepAnUnpluggedUsbRouteAlive() {
        long[] now = {0};
        ConnectionState state = new ConnectionState(() -> now[0]);
        state.heartbeat("usb");
        now[0] = 6000;
        state.heartbeat("wifi");
        assertTrue(state.connected("usb"));
        now[0] = 8000;
        assertTrue(state.connected());
        assertTrue(state.connected("wifi"));
        assertFalse(state.connected("usb"));
    }

    @Test public void olderDesktopsProveConnectionWithoutGuessingTransport() {
        ConnectionState state = new ConnectionState(() -> 10000);
        state.heartbeat("unknown");
        assertTrue(state.connected());
        assertFalse(state.connected("usb"));
        assertFalse(state.connected("wifi"));
    }

    @Test public void usbConnectionConfirmsOnlyUsbWithoutGuessingWifiSwitch() {
        ConnectionState state = new ConnectionState(() -> 1000);
        DebugSettingReading missing = DebugSettingReading.read(() -> null, false);
        assertEquals("enabled", state.debugReading("usbDebugging", missing, true).state);
        assertEquals("usb-connection", state.debugReading("usbDebugging", missing, true).reason);
        state.heartbeat("wifi");
        assertEquals("unconfirmed", state.debugReading("wirelessDebugging", missing, false).state);
    }

    @Test public void trustedDesktopCanReportBothOnAndOffWithoutInferringFromWifiConnection() throws Exception {
        ConnectionState state = new ConnectionState(() -> 1000);
        state.heartbeat("wifi");
        state.reportDebugSettings(new org.json.JSONObject().put("wirelessDebugging", "disabled").put("ageMs", 0));
        assertEquals("disabled", state.debugReading("wirelessDebugging", DebugSettingReading.read(() -> null, false), false).state);
        state.reportDebugSettings(new org.json.JSONObject().put("wirelessDebugging", "enabled").put("ageMs", 0));
        assertEquals("enabled", state.debugReading("wirelessDebugging", DebugSettingReading.read(() -> null, false), false).state);
    }

    @Test public void repeatedHeartbeatsCannotExtendStaleDebugReadings() throws Exception {
        long[] now = {1000};
        ConnectionState state = new ConnectionState(() -> now[0]);
        state.heartbeat("usb");
        state.reportDebugSettings(new org.json.JSONObject().put("wirelessDebugging", "disabled").put("ageMs", 4000));
        assertEquals("disabled", state.debugReading("wirelessDebugging", DebugSettingReading.read(() -> null, false), false).state);
        now[0] = 2999;
        state.heartbeat("usb");
        state.reportDebugSettings(new org.json.JSONObject().put("wirelessDebugging", "disabled").put("ageMs", 5999));
        assertEquals("disabled", state.debugReading("wirelessDebugging", DebugSettingReading.read(() -> null, false), false).state);
        now[0] = 3000;
        assertEquals("unconfirmed", state.debugReading("wirelessDebugging", DebugSettingReading.read(() -> null, false), false).state);
    }

    @Test public void failedReadReplacesOldReadingAndCannotBecomeOff() throws Exception {
        ConnectionState state = new ConnectionState(() -> 1000);
        state.heartbeat("usb");
        state.reportDebugSettings(new org.json.JSONObject().put("wirelessDebugging", "disabled").put("ageMs", 0));
        state.reportDebugSettings(new org.json.JSONObject().put("wirelessDebugging", "unconfirmed").put("ageMs", 0));
        assertEquals("unconfirmed", state.debugReading("wirelessDebugging", DebugSettingReading.read(() -> null, false), false).state);
    }
}
