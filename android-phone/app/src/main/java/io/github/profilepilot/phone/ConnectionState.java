package io.github.profilepilot.phone;

import java.util.HashMap;
import java.util.Map;
import java.util.function.LongSupplier;
import org.json.JSONObject;

/** Connection evidence is short-lived and never grants or resumes control. */
final class ConnectionState {
    private final LongSupplier clock;
    private final Map<String, Long> contacts = new HashMap<>();
    private final Map<String, String> debugSettings = new HashMap<>();
    private long debugValidUntil;
    ConnectionState(LongSupplier clock) { this.clock = clock; }
    void heartbeat(String transport) {
        String route = switch (transport) { case "usb", "wifi", "emulator" -> transport; default -> "unknown"; };
        contacts.put(route, clock.getAsLong());
    }
    boolean connected(String transport) {
        Long last = contacts.get(transport);
        return last != null && clock.getAsLong() - last < SessionState.LEASE_MS;
    }
    boolean connected() { return contacts.keySet().stream().anyMatch(this::connected); }
    void reportDebugSettings(JSONObject report) {
        if (report == null) return;
        long age = Math.max(0, report.optLong("ageMs", 6000));
        debugValidUntil = clock.getAsLong() + Math.max(0, 6000 - age);
        for (String key : new String[] {"developerOptions", "usbDebugging", "wirelessDebugging"}) {
            String value = report.optString(key, "unconfirmed");
            debugSettings.put(key, value.equals("enabled") || value.equals("disabled") ? value : "unconfirmed");
        }
    }
    DebugSettingReading debugReading(String key, DebugSettingReading local, boolean verifiedUsb) {
        if (verifiedUsb) return new DebugSettingReading("enabled", "usb-connection");
        String reported = debugSettings.get(key);
        if (connected() && clock.getAsLong() < debugValidUntil && reported != null && !reported.equals("unconfirmed")) return new DebugSettingReading(reported, "computer-read");
        return local;
    }
}
