package io.github.profilepilot.phone;

import org.junit.Test;
import static org.junit.Assert.*;

public class RecoveryServiceListTest {
    @Test public void ownShortAndFullNamesMatchWithoutConfusingReleaseAndDevelopment() {
        assertTrue(RecoveryServiceList.contains("test/.Service", "test/test.Service"));
        assertFalse(RecoveryServiceList.contains("test/test.Service", "test.debug/test.Service"));
        assertFalse(RecoveryServiceList.contains(null, "test/.Service"));
    }
    @Test public void removingOurServicePreservesEveryOtherServiceAndOrder() {
        String services = "reader/.TalkBack:test/test.Service:manager/.Access";
        assertEquals("reader/.TalkBack:manager/.Access", RecoveryServiceList.without(services, "test/.Service"));
        assertEquals("", RecoveryServiceList.without("test/.Service", "test/test.Service"));
    }
    @Test public void editsByAnotherActorOrExpiredTransactionAreNeverOverwritten() {
        assertTrue(RecoveryServiceList.canRestore("reader/.TalkBack", "reader/.TalkBack", 1500, 1000));
        assertTrue(RecoveryServiceList.canRestore("", "", 1500, 1000));
        assertFalse(RecoveryServiceList.canRestore("reader/.TalkBack:added/.Service", "reader/.TalkBack", 1500, 1000));
        assertFalse(RecoveryServiceList.canRestore(null, "", 1500, 1000));
        assertFalse(RecoveryServiceList.canRestore("", "", 11001, 1000));
        assertFalse(RecoveryServiceList.canRestore("", "", 999, 1000));
    }
}
