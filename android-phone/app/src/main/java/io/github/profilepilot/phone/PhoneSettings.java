package io.github.profilepilot.phone;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.ResolveInfo;
import android.os.Bundle;
import android.provider.Settings;
import android.widget.Toast;

/** User-triggered setup, with system authorization dialogs left to the user. */
final class PhoneSettings {
    static void openWirelessDebugging(Activity activity) {
        openDebugging(activity, DebuggingSetup.Setting.WIRELESS);
    }

    static void openUsbDebugging(Activity activity) {
        openDebugging(activity, DebuggingSetup.Setting.USB);
    }

    private static Intent highlight(Intent intent, String key) {
        // AOSP Settings uses this preference key to scroll to and highlight the
        // requested row. OEMs may ignore these optional extras.
        Bundle arguments = new Bundle();
        arguments.putString(":settings:fragment_args_key", key);
        return intent.putExtra(":settings:fragment_args_key", key)
            .putExtra(":settings:show_fragment_args", arguments);
    }

    private static void openDebugging(Activity activity, DebuggingSetup.Setting setting) {
        cancelPending();
        if (developerDestination(activity) == DeveloperOptionsRoute.Destination.BUILD_NUMBER) {
            openDeveloperSetup(activity);
            return;
        }
        Intent intent = highlight(new Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS), setting.preferenceKey);
        PhoneAccessibility accessibility = PhoneAccessibility.current;
        try {
            ResolveInfo settings = activity.getPackageManager().resolveActivity(intent, 0);
            if (accessibility != null && settings != null && settings.activityInfo != null
                && (settings.activityInfo.applicationInfo.flags & ApplicationInfo.FLAG_SYSTEM) != 0) {
                intent.setClassName(settings.activityInfo.packageName, settings.activityInfo.name);
                accessibility.prepareDebugging(settings.activityInfo.packageName, setting);
            }
            activity.startActivity(intent);
            if (accessibility == null) Toast.makeText(activity, "请打开" + setting.label + "；开启无障碍服务后可自动操作", Toast.LENGTH_LONG).show();
        }
        catch (ActivityNotFoundException | SecurityException unavailable) {
            if (accessibility != null) accessibility.cancelDebugging();
            openDeveloperSetup(activity);
        }
    }

    static void openDeveloperOptions(Activity activity) {
        cancelPending();
        if (developerDestination(activity) == DeveloperOptionsRoute.Destination.BUILD_NUMBER) {
            openDeveloperSetup(activity);
            return;
        }
        try { activity.startActivity(new Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS)); }
        catch (ActivityNotFoundException | SecurityException unavailable) { openDeveloperSetup(activity); }
    }

    private static DeveloperOptionsRoute.Destination developerDestination(Activity activity) {
        PhoneReadiness readiness = new PhoneReadiness(activity);
        ResolveInfo entry = activity.getPackageManager().resolveActivity(new Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS), 0);
        boolean available = entry != null && entry.activityInfo != null && entry.activityInfo.exported
            && (entry.activityInfo.applicationInfo.flags & ApplicationInfo.FLAG_SYSTEM) != 0
            && (entry.activityInfo.permission == null || activity.checkSelfPermission(entry.activityInfo.permission)
                == android.content.pm.PackageManager.PERMISSION_GRANTED);
        return DeveloperOptionsRoute.choose(readiness.developerOptions, readiness.developerOptionsSeenEnabled, available);
    }

    private static void openDeveloperSetup(Activity activity) {
        cancelPending();
        try { activity.startActivity(highlight(new Intent(Settings.ACTION_DEVICE_INFO_SETTINGS), "build_number")); }
        catch (ActivityNotFoundException | SecurityException unavailable) { activity.startActivity(new Intent(Settings.ACTION_SETTINGS)); }
        // Android exposes the current switch, not a reliable first-ever-use marker.
        // This also handles an OEM that hides its developer entry after it is turned off.
        Toast.makeText(activity, "开启开发者选项：连续点击「版本号」7 次；部分手机需先进入「版本信息」，再按系统提示确认", Toast.LENGTH_LONG).show();
    }

    static void openAccessibility(Activity activity) {
        cancelPending();
        ComponentName ownService = new ComponentName(activity, PhoneAccessibility.class);
        // Some OEMs expose this detail intent. AOSP reserves it for system/installers;
        // do not request that privilege, and always retain the public Settings fallback.
        Intent details = new Intent("android.settings.ACCESSIBILITY_DETAILS_SETTINGS")
            .putExtra(Intent.EXTRA_COMPONENT_NAME, ownService);
        ResolveInfo target = activity.getPackageManager().resolveActivity(details, 0);
        if (target != null && target.activityInfo != null
            && (target.activityInfo.applicationInfo.flags & ApplicationInfo.FLAG_SYSTEM) != 0
            && (target.activityInfo.permission == null || activity.checkSelfPermission(target.activityInfo.permission)
                == android.content.pm.PackageManager.PERMISSION_GRANTED)) {
            try {
                details.setClassName(target.activityInfo.packageName, target.activityInfo.name);
                activity.startActivity(details);
                return;
            } catch (ActivityNotFoundException | SecurityException unavailable) { /* Use public entry. */ }
        }
        try {
            activity.startActivity(highlight(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS), ownService.flattenToString()));
        } catch (ActivityNotFoundException | SecurityException unavailable) {
            activity.startActivity(new Intent(Settings.ACTION_SETTINGS));
        }
        Toast.makeText(activity, "在已安装或已下载的服务中打开「ProfilePilot 手机控制」，按系统提示确认", Toast.LENGTH_LONG).show();
    }

    private static void cancelPending() {
        if (PhoneAccessibility.current != null) PhoneAccessibility.current.cancelDebugging();
    }
}
