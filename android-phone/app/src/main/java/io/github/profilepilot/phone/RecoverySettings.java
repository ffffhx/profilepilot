package io.github.profilepilot.phone;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;

// Recovery defaults on; explicitly saved choices and retry budgets survive process death.
@SuppressLint("ApplySharedPref")
final class RecoverySettings {
    private final Context context;
    final SharedPreferences prefs;
    RecoverySettings(Context context) {
        this.context = context;
        prefs = context.getSharedPreferences("automatic_recovery", Context.MODE_PRIVATE);
    }
    boolean enabled() { return prefs.getBoolean("enabled", true); }
    boolean advancedPreference() { return prefs.getBoolean("advanced", true); }
    boolean accessibilityPreference() { return prefs.getBoolean("accessibility_on", true); }
    boolean advanced() { return enabled() && advancedPreference(); }
    boolean accessibilityOn() { return enabled() && accessibilityPreference(); }
    void accessibilityOn(boolean value) {
        SharedPreferences.Editor edit = prefs.edit().putBoolean("accessibility_on", value);
        if (value && !accessibilityPreference()) edit.putInt("accessibility_attempts", 0).putLong("accessibility_window", System.currentTimeMillis());
        edit.commit();
    }
    boolean authorized() { return context.checkSelfPermission(Manifest.permission.WRITE_SECURE_SETTINGS) == PackageManager.PERMISSION_GRANTED; }
    boolean paired() { return context.getSharedPreferences("MainActivity", Context.MODE_PRIVATE).getString("token", "").matches("[a-f0-9]{64}"); }
    void enabled(boolean value) {
        prefs.edit().putBoolean("enabled", value).commit();
        record(value ? "已开启后台服务恢复" : "已关闭自动恢复");
    }
    void advanced(boolean value) { prefs.edit().putBoolean("advanced", value).commit(); }
    void record(String message) { prefs.edit().putString("last_result", message).putLong("last_result_at", System.currentTimeMillis()).apply(); }
    String lastResult() { return prefs.getString("last_result", "尚未执行恢复"); }
    long lastResultAt() { return prefs.getLong("last_result_at", 0); }
    boolean takeAttempt(String kind) {
        long now = System.currentTimeMillis(), start = prefs.getLong(kind + "_window", now);
        int attempts = prefs.getInt(kind + "_attempts", 0);
        if (!RecoveryPolicy.budgetAvailable(now, start, attempts)) return false;
        if (now >= start && now - start >= 1_800_000) { start = now; attempts = 0; }
        return prefs.edit().putLong(kind + "_window", start).putInt(kind + "_attempts", attempts + 1).commit();
    }
}
