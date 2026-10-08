package io.github.profilepilot.phone;

import org.junit.Test;
import static org.junit.Assert.*;

public class DebugSettingReadingTest {
    @Test public void wirelessOffIsDifferentFromAnUnreadableSetting() {
        assertReading("enabled", "system-value", DebugSettingReading.read(() -> "1", false));
        assertReading("disabled", "system-value", DebugSettingReading.read(() -> "0", false));
        assertReading("unconfirmed", "missing", DebugSettingReading.read(() -> null, false));
        assertReading("unconfirmed", "invalid", DebugSettingReading.read(() -> "", false));
        assertReading("unconfirmed", "invalid", DebugSettingReading.read(() -> "unexpected", false));
    }

    @Test public void maskedPublicSettingsAreNeverMisrepresentedAsOff() {
        assertReading("unconfirmed", "masked-zero", DebugSettingReading.read(() -> "0", true));
        assertReading("enabled", "system-value", DebugSettingReading.read(() -> "1", true));
    }

    @Test public void deniedAndFailedReadsKeepDistinctCausesWithoutExceptionDetails() {
        assertReading("unconfirmed", "denied", DebugSettingReading.read(() -> { throw new SecurityException("private detail"); }, false));
        assertReading("unconfirmed", "error", DebugSettingReading.read(() -> { throw new IllegalStateException("private detail"); }, false));
    }

    @Test public void staleComputerEvidenceFallsBackToCurrentLocalReadingAndReason() throws Exception {
        long[] now = {1000};
        ConnectionState state = new ConnectionState(() -> now[0]);
        state.heartbeat("wifi");
        state.reportDebugSettings(new org.json.JSONObject().put("wirelessDebugging", "enabled").put("ageMs", 0));
        DebugSettingReading local = DebugSettingReading.read(() -> "0", false);
        assertReading("enabled", "computer-read", state.debugReading("wirelessDebugging", local, false));
        now[0] = 7000;
        state.heartbeat("wifi");
        assertReading("disabled", "system-value", state.debugReading("wirelessDebugging", local, false));
        DebugSettingReading failed = DebugSettingReading.read(() -> { throw new SecurityException(); }, false);
        assertReading("unconfirmed", "denied", state.debugReading("wirelessDebugging", failed, false));
    }

    private static void assertReading(String expectedState, String expectedReason, DebugSettingReading actual) {
        assertEquals(expectedState, actual.state);
        assertEquals(expectedReason, actual.reason);
    }
}
