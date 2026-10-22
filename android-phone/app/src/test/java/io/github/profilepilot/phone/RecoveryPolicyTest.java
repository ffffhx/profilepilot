package io.github.profilepilot.phone;

import org.junit.Test;
import static org.junit.Assert.*;

public class RecoveryPolicyTest {
    private RecoveryPolicy lostWifi() {
        RecoveryPolicy p = new RecoveryPolicy();
        p.observeWifi(0, true, true);
        p.networkLost(1000);
        p.observeWifi(1100, false, false);
        p.observeWifi(2000, true, false);
        return p;
    }
    @Test public void freshProcessDoesNotEnablePreviouslyDisabledDebugging() {
        RecoveryPolicy p = new RecoveryPolicy();
        p.observeWifi(0, true, false); p.networkLost(1000); p.observeWifi(2000, true, false);
        assertFalse(p.recoverWifi(9000, true, false, true));
    }
    @Test public void lossNeedsPreviouslyEnabledDebuggingStableNetworkAndAuthorization() {
        RecoveryPolicy p = lostWifi();
        assertFalse(p.recoverWifi(6999, true, false, true));
        assertFalse(p.recoverWifi(7000, true, false, false));
        assertFalse(p.recoverWifi(7000, false, false, true));
        assertFalse(p.recoverWifi(7000, true, null, true));
        assertFalse(p.recoverWifi(7000, true, true, true));
        assertTrue(p.recoverWifi(7000, true, false, true));
    }
    @Test public void stableManualOffDisarmsLaterNetworkRecovery() {
        RecoveryPolicy p = new RecoveryPolicy();
        p.observeWifi(0, true, true); p.observeWifi(6000, true, false);
        p.networkLost(7000); p.observeWifi(8000, true, false);
        assertFalse(p.recoverWifi(15000, true, false, true));
    }
    @Test public void retriesBackOffAndStopAfterThree() {
        RecoveryPolicy p = lostWifi();
        assertTrue(p.recoverWifi(7000, true, false, true)); p.wifiAttempt(7000);
        assertFalse(p.recoverWifi(21999, true, false, true));
        assertTrue(p.recoverWifi(22000, true, false, true)); p.wifiAttempt(22000);
        assertFalse(p.recoverWifi(81999, true, false, true));
        assertTrue(p.recoverWifi(82000, true, false, true)); p.wifiAttempt(82000);
        assertFalse(p.recoverWifi(200000, true, false, true));
    }
    @Test public void lateNetworkCannotReuseOldRecoveryIntent() {
        RecoveryPolicy p = lostWifi(); p.observeWifi(301001, true, false);
        assertFalse(p.networkPending()); assertFalse(p.recoverWifi(310000, true, false, true));
    }
    @Test public void repeatedLossDoesNotExtendRecoveryWindowOrResetAttempts() {
        RecoveryPolicy p = lostWifi(); p.wifiAttempt(7000); p.wifiAttempt(22000); p.wifiAttempt(82000);
        p.networkLost(90000); p.observeWifi(91000, true, false);
        assertFalse(p.recoverWifi(100000, true, false, true));
    }
    @Test public void recoverySuccessDoesNotReopenSubsequentManualOff() {
        RecoveryPolicy p = lostWifi(); p.observeWifi(7000, true, true); p.observeWifi(8000, true, false);
        assertFalse(p.networkPending()); assertFalse(p.recoverWifi(9000, true, false, true));
    }
    @Test public void delayedOffAfterNetworkArrivalCanStillRecover() {
        RecoveryPolicy p = new RecoveryPolicy(); p.observeWifi(0, true, true); p.networkLost(1000);
        p.observeWifi(2000, true, true); p.observeWifi(2500, true, false);
        assertTrue(p.recoverWifi(7000, true, false, true));
    }
    @Test public void disabledOrRunningAccessibilityIsNeverToggled() {
        RecoveryPolicy p = new RecoveryPolicy();
        assertFalse(p.recoverAccessibility(0, false, false, true));
        assertFalse(p.recoverAccessibility(100000, false, false, true));
        assertFalse(p.recoverAccessibility(200000, true, true, true));
    }
    @Test public void accessibilityRequiresGraceAndPermissionAndRechecksAfterAttempt() {
        RecoveryPolicy p = new RecoveryPolicy();
        assertFalse(p.recoverAccessibility(0, true, false, true));
        assertFalse(p.recoverAccessibility(19999, true, false, true));
        assertFalse(p.recoverAccessibility(20000, true, false, false));
        assertTrue(p.recoverAccessibility(20000, true, false, true)); p.accessibilityAttempt(20000);
        assertFalse(p.recoverAccessibility(39999, true, false, true));
        assertTrue(p.recoverAccessibility(40000, true, false, true));
        p.recoverAccessibility(40001, true, true, true);
        assertFalse(p.recoverAccessibility(40002, true, false, true));
    }
    @Test public void persistentBudgetSurvivesProcessRestartAndClockRollback() {
        assertFalse(RecoveryPolicy.budgetAvailable(2000, 1000, 3));
        assertFalse(RecoveryPolicy.budgetAvailable(500, 1000, 3));
        assertFalse(RecoveryPolicy.budgetAvailable(1800999, 1000, 3));
        assertTrue(RecoveryPolicy.budgetAvailable(1801000, 1000, 3));
        assertTrue(RecoveryPolicy.budgetAvailable(2000, 1000, 2));
    }
}
