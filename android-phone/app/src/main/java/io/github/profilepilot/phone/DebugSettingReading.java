package io.github.profilepilot.phone;

import java.util.function.Supplier;

/** Preserve why a setting is unknown instead of treating every result as a platform restriction. */
final class DebugSettingReading {
    final String state, reason;
    DebugSettingReading(String state, String reason) { this.state = state; this.reason = reason; }

    static DebugSettingReading read(Supplier<String> reader, boolean mayMaskZero) {
        try {
            String value = reader.get();
            if ("1".equals(value)) return new DebugSettingReading("enabled", "system-value");
            if ("0".equals(value)) return new DebugSettingReading(mayMaskZero ? "unconfirmed" : "disabled", mayMaskZero ? "masked-zero" : "system-value");
            return new DebugSettingReading("unconfirmed", value == null ? "missing" : "invalid");
        } catch (SecurityException denied) {
            return new DebugSettingReading("unconfirmed", "denied");
        } catch (RuntimeException failed) {
            return new DebugSettingReading("unconfirmed", "error");
        }
    }
}
