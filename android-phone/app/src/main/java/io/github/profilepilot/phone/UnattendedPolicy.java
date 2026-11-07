package io.github.profilepilot.phone;

/** The idle wake lock is held only while the user opted in and the phone is charging. */
final class UnattendedPolicy {
    private UnattendedPolicy() { }
    static boolean shouldHold(boolean enabled, boolean charging) { return enabled && charging; }

    /** A full battery can report NOT_CHARGING; being plugged in still prevents Doze. */
    static boolean charging(android.content.Context context) {
        android.os.BatteryManager battery = context.getSystemService(android.os.BatteryManager.class);
        if (battery != null && battery.isCharging()) return true;
        android.content.Intent status = context.registerReceiver(null,
            new android.content.IntentFilter(android.content.Intent.ACTION_BATTERY_CHANGED));
        return status != null && status.getIntExtra(android.os.BatteryManager.EXTRA_PLUGGED, 0) != 0;
    }
}
