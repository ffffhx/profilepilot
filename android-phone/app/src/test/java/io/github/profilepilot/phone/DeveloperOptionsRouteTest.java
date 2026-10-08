package io.github.profilepilot.phone;

import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;
import static io.github.profilepilot.phone.DeveloperOptionsRoute.Destination.*;

public class DeveloperOptionsRouteTest {
    @Test public void confirmedFirstSetupThenEnabledUserTakesDifferentRoutes() {
        boolean history = DeveloperOptionsRoute.rememberEnabled(false, "disabled");
        assertEquals(BUILD_NUMBER, DeveloperOptionsRoute.choose("disabled", history, true));
        // Visiting setup alone is not success; only an observed enabled state is saved.
        assertFalse(history);
        history = DeveloperOptionsRoute.rememberEnabled(history, "enabled");
        assertTrue(history);
        assertEquals(DEVELOPER_OPTIONS, DeveloperOptionsRoute.choose("enabled", history, true));
        assertEquals(DEVELOPER_OPTIONS, DeveloperOptionsRoute.choose("disabled", history, true));
    }

    @Test public void disconnectedComputerDoesNotSendReturningUserThroughFirstSetup() throws Exception {
        long[] time = {1000};
        ConnectionState connection = new ConnectionState(() -> time[0]);
        connection.heartbeat("usb");
        connection.reportDebugSettings(new JSONObject().put("developerOptions", "enabled").put("ageMs", 0));
        String current = connection.debugReading("developerOptions", DebugSettingReading.read(() -> "0", true), false).state;
        boolean history = DeveloperOptionsRoute.rememberEnabled(false, current);
        time[0] += SessionState.LEASE_MS;
        current = connection.debugReading("developerOptions", DebugSettingReading.read(() -> "0", true), false).state;
        assertEquals("unconfirmed", current);
        history = DeveloperOptionsRoute.rememberEnabled(history, current);
        assertTrue(history);
        assertEquals(DEVELOPER_OPTIONS, DeveloperOptionsRoute.choose(current, history, true));
    }

    @Test public void maskedZeroOnNewInstallDoesNotProveDeveloperOptionsWereNeverEnabled() {
        String masked = DebugSettingReading.read(() -> "0", true).state;
        boolean history = DeveloperOptionsRoute.rememberEnabled(false, masked);
        assertFalse(history);
        assertEquals(DEVELOPER_OPTIONS, DeveloperOptionsRoute.choose(masked, history, true));
        assertEquals(BUILD_NUMBER, DeveloperOptionsRoute.choose(masked, history, false));
    }

    @Test public void hiddenOrRestrictedEntryFallsBackEvenForReturningUser() {
        for (String state : new String[] {"enabled", "disabled", "unconfirmed"})
            assertEquals(BUILD_NUMBER, DeveloperOptionsRoute.choose(state, true, false));
    }
}
