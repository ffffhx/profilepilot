package io.github.profilepilot.phone;

import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;

/** Read-only init status, independent of the wireless-debugging settings switch. */
final class AdbDaemonProbe {
    static String read() {
        Process process = null;
        try {
            process = new ProcessBuilder("/system/bin/getprop", "init.svc.adbd").redirectErrorStream(true).start();
            if (!process.waitFor(2, TimeUnit.SECONDS) || process.exitValue() != 0) return "unknown";
            byte[] output = new byte[128];
            int length = process.getInputStream().read(output);
            String value = length < 0 ? "" : new String(output, 0, length, StandardCharsets.UTF_8).trim();
            return value.equals("running") || value.equals("stopped") || value.equals("restarting") ? value : "unknown";
        } catch (Exception unavailable) {
            if (unavailable instanceof InterruptedException) Thread.currentThread().interrupt();
            return "unknown";
        } finally { if (process != null) process.destroy(); }
    }
}
