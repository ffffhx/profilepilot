package io.github.profilepilot.phone;

import static org.junit.Assert.*;
import android.app.UiAutomation;
import android.content.Context;
import android.content.Intent;
import android.os.SystemClock;
import android.provider.Settings;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Run only on a paired test phone with explicit accessibility-recovery opt-in. */
@RunWith(AndroidJUnit4.class)
public class AccessibilityRecoveryTest {
    @Test public void disabledMasterSwitchIsRestoredByTheRunningRecoveryService() throws Exception {
        var instrumentation = InstrumentationRegistry.getInstrumentation();
        instrumentation.getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
        Context context = instrumentation.getTargetContext();
        RecoverySettings settings = new RecoverySettings(context);
        assertTrue("Requires explicit recovery opt-in", settings.accessibilityOn());
        assertTrue(settings.authorized()); assertTrue(settings.paired());
        String before = Settings.Secure.getString(context.getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
        AccessibilityRecovery.enable(context);
        context.startForegroundService(new Intent(context, ControlService.class));
        long deadline = SystemClock.elapsedRealtime() + 5000;
        while (ControlService.current == null && SystemClock.elapsedRealtime() < deadline) SystemClock.sleep(50);
        assertNotNull(ControlService.current);
        assertFalse(ControlService.current.session.active());
        try {
            assertTrue(Settings.Secure.putInt(context.getContentResolver(), Settings.Secure.ACCESSIBILITY_ENABLED, 0));
            assertEquals(0, Settings.Secure.getInt(context.getContentResolver(), Settings.Secure.ACCESSIBILITY_ENABLED, -1));
            deadline = SystemClock.elapsedRealtime() + 40000;
            while ((!AccessibilityRecovery.enabled(context) || PhoneAccessibility.current == null) && SystemClock.elapsedRealtime() < deadline) SystemClock.sleep(100);
            assertTrue("Automatic recovery must restore the master switch", AccessibilityRecovery.enabled(context));
            assertNotNull("Actual service binding must return", PhoneAccessibility.current);
            assertEquals("Other service entries must be preserved", before, Settings.Secure.getString(context.getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES));
            assertFalse("Recovery must not start input", ControlService.current.session.active());
        } finally { AccessibilityRecovery.enable(context); }
    }
}
