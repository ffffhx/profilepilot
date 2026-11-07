package io.github.profilepilot.phone;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class UnattendedPolicyTest {
    @Test public void theIdleLockNeedsBothOptInAndCharging() {
        assertFalse(UnattendedPolicy.shouldHold(false, false));
        assertFalse(UnattendedPolicy.shouldHold(false, true));
        assertFalse(UnattendedPolicy.shouldHold(true, false));
        assertTrue(UnattendedPolicy.shouldHold(true, true));
    }
}
