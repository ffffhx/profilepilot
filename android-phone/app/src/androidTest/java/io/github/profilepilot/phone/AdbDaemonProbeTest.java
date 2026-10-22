package io.github.profilepilot.phone;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public class AdbDaemonProbeTest {
    @Test public void runningDeviceDaemonIsReadableFromAppProcess() {
        // Run only on a device currently connected to the test host.
        assertEquals("running", AdbDaemonProbe.read());
    }
}
