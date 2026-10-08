package io.github.profilepilot.phone;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.KeyguardManager;
import android.app.NotificationManager;
import android.content.ComponentName;
import android.content.Context;
import android.provider.Settings;
import android.view.accessibility.AccessibilityManager;
import org.json.JSONObject;

/** Read-only system diagnostics; local history only remembers confirmed setup. */
final class PhoneReadiness {
    final boolean overlay, notifications, unlocked, computerConnected, usbConnected, wifiConnected;
    final String accessibilityService, developerOptions, usbDebugging, wirelessDebugging;
    final boolean developerOptionsSeenEnabled;
    private final DebugSettingReading developerReading, usbReading, wirelessReading;
    private final Context context;

    PhoneReadiness(Context context) {
        this.context = context;
        overlay = Settings.canDrawOverlays(context);
        notifications = context.getSystemService(NotificationManager.class).areNotificationsEnabled();
        unlocked = !context.getSystemService(KeyguardManager.class).isKeyguardLocked();
        accessibilityService = accessibilityState(context);
        ControlService service = ControlService.current;
        computerConnected = service != null && service.connection.connected();
        usbConnected = service != null && service.connection.connected("usb");
        wifiConnected = service != null && service.connection.connected("wifi");
        ConnectionState connection = service == null ? new ConnectionState(android.os.SystemClock::elapsedRealtime) : service.connection;
        developerReading = connection.debugReading("developerOptions", read(context, Settings.Global.DEVELOPMENT_SETTINGS_ENABLED, true), false);
        developerOptions = developerReading.state;
        // Keep navigation history separate from computer pairing. Forgetting a computer,
        // disconnecting, or a masked system read must not classify an existing user as new.
        android.content.SharedPreferences setup = context.getSharedPreferences("phone_setup", Context.MODE_PRIVATE);
        boolean seenEnabled = setup.getBoolean("developer_options_seen_enabled", false);
        developerOptionsSeenEnabled = DeveloperOptionsRoute.rememberEnabled(seenEnabled, developerOptions);
        if (developerOptionsSeenEnabled != seenEnabled) setup.edit().putBoolean("developer_options_seen_enabled", true).apply();
        usbReading = connection.debugReading("usbDebugging", read(context, Settings.Global.ADB_ENABLED, true), usbConnected);
        usbDebugging = usbReading.state;
        // adb_wifi_enabled is a readable AOSP setting. Unlike the public USB and
        // developer-options keys, zero is an off value, not a documented masked value.
        // Missing keys and vendor read failures remain unknown with their actual cause.
        wirelessReading = connection.debugReading("wirelessDebugging", read(context, "adb_wifi_enabled", false), false);
        wirelessDebugging = wirelessReading.state;
    }

    private static DebugSettingReading read(Context context, String name, boolean mayMaskZero) {
        return DebugSettingReading.read(() -> Settings.Global.getString(context.getContentResolver(), name), mayMaskZero);
    }

    private static String accessibilityState(Context context) {
        if (PhoneAccessibility.current != null) return "running";
        try {
            AccessibilityManager manager = context.getSystemService(AccessibilityManager.class);
            if (manager == null) return "unknown";
            ComponentName own = new ComponentName(context, PhoneAccessibility.class);
            for (AccessibilityServiceInfo info : manager.getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_ALL_MASK)) {
                if (own.equals(ComponentName.unflattenFromString(info.getId()))) return "enabled";
            }
            return "disabled";
        } catch (RuntimeException unavailable) { return "unknown"; }
    }

    String accessibilityLabel() {
        return switch (accessibilityService) {
            case "running" -> "已开启 · 正在运行";
            case "enabled" -> "已开启 · 服务未运行";
            case "disabled" -> "未开启";
            default -> "无法读取";
        };
    }
    String connectionLabel() {
        if (usbConnected && wifiConnected) return "USB 与无线连接在线";
        if (usbConnected) return "USB 已连接 · 电脑已授权";
        if (wifiConnected) return "无线连接在线 · 电脑已授权";
        return computerConnected ? "电脑已连接" : "尚未检测到电脑连接";
    }
    String debugLabel(String key) {
        DebugSettingReading reading = switch (key) {
            case "developerOptions" -> developerReading;
            case "usbDebugging" -> usbReading;
            case "wirelessDebugging" -> wirelessReading;
            default -> throw new IllegalArgumentException("Unknown debug setting");
        };
        return switch (reading.state) {
            case "enabled" -> "已开启";
            case "disabled" -> "未开启";
            default -> switch (reading.reason) {
                case "denied" -> "系统拒绝读取";
                case "missing" -> "系统未提供状态";
                case "error" -> "读取失败";
                case "invalid" -> "状态异常";
                default -> "状态待确认";
            };
        };
    }

    JSONObject json() throws Exception {
        return new JSONObject().put("unlocked", unlocked).put("computerConnected", computerConnected)
            .put("usbConnected", usbConnected).put("wifiConnected", wifiConnected)
            .put("developerOptions", developerOptions).put("usbDebugging", usbDebugging)
            .put("wirelessDebugging", wirelessDebugging).put("accessibilityService", accessibilityService)
            .put("debugReasons", new JSONObject().put("developerOptions", developerReading.reason)
                .put("usbDebugging", usbReading.reason).put("wirelessDebugging", wirelessReading.reason))
            .put("appVersion", BuildConfig.VERSION_NAME).put("network", WirelessNetwork.snapshot(context));
    }
}
