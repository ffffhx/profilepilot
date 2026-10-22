package io.github.profilepilot.phone;

import android.content.ComponentName;
import android.annotation.SuppressLint;
import android.content.Context;
import android.provider.Settings;
import android.os.Handler;
import android.os.Looper;

/** Explicit setup operation; independent of accessibility and control leases. */
@SuppressLint("ApplySharedPref") // Persist the rollback journal before touching system settings.
final class AccessibilityRecovery {
    static boolean enabled(Context context) {
        String own = new ComponentName(context, PhoneAccessibility.class).flattenToString();
        return Settings.Secure.getInt(context.getContentResolver(), Settings.Secure.ACCESSIBILITY_ENABLED, 0) == 1
            && RecoveryServiceList.contains(Settings.Secure.getString(context.getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES), own);
    }
    static void enable(Context context) {
        if (!new RecoverySettings(context).authorized()) throw new IllegalStateException("需要电脑授予高级恢复权限");
        String own = new ComponentName(context, PhoneAccessibility.class).flattenToString();
        String before = Settings.Secure.getString(context.getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
        String after = RecoveryServiceList.with(before, own);
        if (!java.util.Objects.equals(before, Settings.Secure.getString(context.getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES)))
            throw new IllegalStateException("无障碍设置已变化，请重新检查");
        if (!after.equals(before) && !Settings.Secure.putString(context.getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES, after))
            throw new IllegalStateException("系统未接受无障碍服务设置");
        if (!Settings.Secure.putInt(context.getContentResolver(), Settings.Secure.ACCESSIBILITY_ENABLED, 1))
            throw new IllegalStateException("系统未接受无障碍总开关设置");
    }
    static void rebind(Context context) {
        if (PhoneAccessibility.current != null || !enabled(context)) return;
        RecoverySettings settings = new RecoverySettings(context);
        if (!settings.authorized() || !settings.paired() || settings.prefs.contains("rebind_original")) return;
        String original = Settings.Secure.getString(context.getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
        String own = new ComponentName(context, PhoneAccessibility.class).flattenToString();
        String remaining = RecoveryServiceList.without(original, own);
        if (!settings.prefs.edit().putString("rebind_original", original).putString("rebind_remaining", remaining)
                .putLong("rebind_at", System.currentTimeMillis()).commit()) throw new IllegalStateException("无法保存恢复事务");
        try {
            if (!original.equals(Settings.Secure.getString(context.getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES))
                    || !Settings.Secure.putString(context.getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES, remaining)) {
                clear(settings); throw new IllegalStateException("无障碍设置已变化，已取消恢复");
            }
            settings.record("正在重新连接已授权的无障碍服务");
            new Handler(Looper.getMainLooper()).postDelayed(() -> restore(context), 500);
        } catch (RuntimeException error) { restore(context); throw error; }
    }
    private static void clear(RecoverySettings settings) {
        settings.prefs.edit().remove("rebind_original").remove("rebind_remaining").remove("rebind_at").commit();
    }
    static boolean restore(Context context) {
        RecoverySettings settings = new RecoverySettings(context);
        String original = settings.prefs.getString("rebind_original", null);
        if (original == null) return false;
        try {
            String current = Settings.Secure.getString(context.getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
            if (settings.authorized() && settings.paired() && RecoveryServiceList.canRestore(current,
                    settings.prefs.getString("rebind_remaining", ""), System.currentTimeMillis(), settings.prefs.getLong("rebind_at", 0))) {
                boolean restored = Settings.Secure.putString(context.getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES, original);
                // Removing the last service can clear the master switch as well.
                if (restored) restored = Settings.Secure.putInt(context.getContentResolver(), Settings.Secure.ACCESSIBILITY_ENABLED, 1);
                settings.record(restored ? "已请求重启无障碍服务，等待系统绑定；控制保持暂停" : "无障碍服务未恢复，请检查系统设置");
                return restored;
            }
            settings.record("无障碍设置已变化或恢复已超时，请检查系统设置");
            return false;
        } catch (RuntimeException denied) { settings.record("无障碍恢复被系统拒绝，请检查高级授权"); return false; }
        finally { clear(settings); }
    }
}
