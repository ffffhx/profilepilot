package io.github.profilepilot.phone;

import android.content.ComponentName;
import android.annotation.SuppressLint;
import android.database.ContentObserver;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Runs only inside the visible foreground connection service; no wake lock or exact alarms. */
final class AutomaticRecovery implements AutoCloseable {
    private final ControlService service;
    private final RecoverySettings settings;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ConnectivityManager connectivity;
    private final Set<Network> networks = new HashSet<>();
    private final RecoveryPolicy policy = new RecoveryPolicy();
    private final String own;
    private boolean closed, registered, awaitingAccessibility, awaitingWifi;
    private boolean probingAdb, restartingWifi;
    private final ExecutorService daemonProbe = Executors.newSingleThreadExecutor();
    private Set<Network> restartNetworks;
    private final Runnable check = new Runnable() {
        @Override public void run() {
            if (closed) return;
            inspect();
            main.removeCallbacks(this);
            main.postDelayed(this, 5_000);
        }
    };
    private final ContentObserver observer = new ContentObserver(main) {
        @Override public void onChange(boolean selfChange) { schedule(); }
    };
    private final ConnectivityManager.NetworkCallback network = new ConnectivityManager.NetworkCallback() {
        @Override public void onAvailable(Network value) { networks.add(value); schedule(); }
        @Override public void onLost(Network value) {
            if (networks.remove(value)) policy.networkLost(SystemClock.elapsedRealtime());
            schedule();
        }
    };

    AutomaticRecovery(ControlService service) {
        this.service = service; settings = new RecoverySettings(service);
        own = new ComponentName(service, PhoneAccessibility.class).flattenToString();
        connectivity = service.getSystemService(ConnectivityManager.class);
        restoreOwnedRebind();
        try {
            for (Network value : connectivity.getAllNetworks()) {
                NetworkCapabilities caps = connectivity.getNetworkCapabilities(value);
                if (caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) && !caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) networks.add(value);
            }
            connectivity.registerNetworkCallback(new NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
                .addCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN).build(), network, main);
            registered = true;
            service.getContentResolver().registerContentObserver(Settings.Global.getUriFor("adb_wifi_enabled"), false, observer);
            service.getContentResolver().registerContentObserver(Settings.Secure.getUriFor(Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES), false, observer);
            completeWifiRestart();
            main.post(check);
        } catch (RuntimeException unavailable) {
            settings.record("系统限制了自动恢复检测，请打开连接设置检查"); close();
        }
    }
    private void schedule() {
        if (closed) return;
        main.removeCallbacks(check); main.postDelayed(check, 500);
    }
    private Boolean wifiDebugging() {
        try {
            String value = Settings.Global.getString(service.getContentResolver(), "adb_wifi_enabled");
            return "1".equals(value) ? Boolean.TRUE : "0".equals(value) ? Boolean.FALSE : null;
        } catch (RuntimeException denied) { return null; }
    }
    private void inspect() {
        if (!settings.advanced() || !settings.paired()) return;
        long now = SystemClock.elapsedRealtime();
        boolean authorized = settings.authorized(), connected = !networks.isEmpty();
        Boolean debugging = wifiDebugging();
        if (awaitingWifi && service.connection.connected("wifi")) {
            awaitingWifi = false; settings.record("无线调试已恢复，电脑已重新连接；旧控制会话未恢复");
        }
        if (awaitingAccessibility && PhoneAccessibility.current != null) {
            awaitingAccessibility = false; settings.record("无障碍服务已恢复；旧控制会话保持暂停");
        }
        if (!restartingWifi) policy.observeWifi(now, connected, debugging);
        if (!restartingWifi && policy.recoverWifi(now, connected, debugging, authorized)) {
            policy.wifiAttempt(now);
            if (settings.takeAttempt("wifi")) {
                try {
                    boolean accepted = Settings.Global.putInt(service.getContentResolver(), "adb_wifi_enabled", 1);
                    awaitingWifi = accepted;
                    settings.record(accepted ? "已请求恢复无线调试；如系统询问网络授权，请在手机确认" : "系统未接受无线调试恢复，请手动检查");
                } catch (RuntimeException denied) { settings.record("无线调试恢复被系统拒绝，请检查高级授权"); }
            } else settings.record("无线调试恢复次数已达上限，请检查网络后手动开启");
        }
        inspectAdbDaemon();
        try {
            String enabled = Settings.Secure.getString(service.getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
            if (policy.recoverAccessibility(now, RecoveryServiceList.contains(enabled, own), PhoneAccessibility.current != null, authorized)) {
                policy.accessibilityAttempt(now);
                if (settings.takeAttempt("accessibility")) rebind(enabled);
                // Do not overwrite the last useful result on every subsequent tick.
            }
        } catch (RuntimeException denied) { settings.record("无法检查无障碍服务，请在系统设置核对"); }
    }
    private boolean canInspectAdb() {
        return !closed && settings.advanced() && settings.authorized() && settings.paired()
            && !networks.isEmpty() && Boolean.TRUE.equals(wifiDebugging())
            && !service.connection.connected() && !service.session.active() && !restartingWifi;
    }
    private void inspectAdbDaemon() {
        if (!canInspectAdb()) {
            policy.recoverStoppedAdb(SystemClock.elapsedRealtime(), false, "unknown");
            return;
        }
        if (probingAdb) return;
        probingAdb = true;
        daemonProbe.execute(() -> {
            String state = AdbDaemonProbe.read();
            main.post(() -> {
                probingAdb = false;
                if (closed) return;
                long now = SystemClock.elapsedRealtime();
                if (policy.recoverStoppedAdb(now, canInspectAdb(), state)) {
                    policy.stoppedAdbAttempt(now);
                    if (settings.takeAttempt("wifi")) restartWifi();
                }
            });
        });
    }
    @SuppressLint("ApplySharedPref")
    private void restartWifi() {
        if (!canInspectAdb()) return;
        // Journal only this short OFF/ON transaction, never a user's disabled setting.
        long at = System.currentTimeMillis();
        if (!settings.prefs.edit().putLong("wifi_restart_at", at).commit()) return;
        restartNetworks = new HashSet<>(networks);
        restartingWifi = true;
        try {
            if (Settings.Global.putInt(service.getContentResolver(), "adb_wifi_enabled", 0)) {
                settings.record("无线调试已开启但 ADB 服务持续停止，正在重启调试服务");
                main.postDelayed(this::completeWifiRestart, 750);
                return;
            }
        } catch (RuntimeException denied) { settings.record("系统拒绝重启无线调试，请手动关闭后重新开启"); }
        clearWifiRestart();
    }
    @SuppressLint("ApplySharedPref")
    private void clearWifiRestart() {
        restartingWifi = false; restartNetworks = null;
        settings.prefs.edit().remove("wifi_restart_at").commit();
    }
    private void completeWifiRestart() {
        long at = settings.prefs.getLong("wifi_restart_at", 0);
        if (at == 0) return;
        try {
            boolean allowed = settings.advanced() && settings.authorized() && settings.paired() && !networks.isEmpty()
                && (restartNetworks == null || restartNetworks.equals(networks));
            if (RecoveryPolicy.canCompleteWifiRestart(System.currentTimeMillis(), at, allowed, wifiDebugging())) {
                awaitingWifi = Settings.Global.putInt(service.getContentResolver(), "adb_wifi_enabled", 1);
                settings.record(awaitingWifi ? "已请求重启无线调试，等待电脑重新连接；旧控制会话未恢复" : "系统未接受无线调试重启，请手动检查");
            }
        } catch (RuntimeException denied) { settings.record("无线调试重启未完成，请在系统设置重新开启"); }
        finally { clearWifiRestart(); }
    }
    private void rebind(String enabled) {
        if (!settings.advanced() || PhoneAccessibility.current != null || !RecoveryServiceList.contains(enabled, own)) return;
        // Do not resume the old lease when the service returns.
        service.session.pause("无障碍服务中断，控制已暂停");
        String remaining = RecoveryServiceList.without(enabled, own);
        if (!settings.prefs.edit().putString("rebind_original", enabled).putString("rebind_remaining", remaining)
            .putLong("rebind_at", System.currentTimeMillis()).commit()) return;
        try {
            // Recheck immediately before writing; never overwrite a newer settings snapshot.
            if (!enabled.equals(Settings.Secure.getString(service.getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES))
                || !Settings.Secure.putString(service.getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES, remaining)) {
                clearRebind(); settings.record("无障碍设置发生变化，已取消恢复"); return;
            }
            settings.record("正在重新连接已授权的无障碍服务");
            main.postDelayed(this::restoreOwnedRebind, 500);
        } catch (RuntimeException denied) { clearRebind(); settings.record("系统拒绝重启无障碍服务，请手动检查"); }
    }
    @SuppressLint("ApplySharedPref") // The rollback journal must not outlive its owned setting edit.
    private void clearRebind() { settings.prefs.edit().remove("rebind_original").remove("rebind_remaining").remove("rebind_at").commit(); }
    private void restoreOwnedRebind() {
        String original = settings.prefs.getString("rebind_original", null);
        if (original == null) return;
        try {
            String current = Settings.Secure.getString(service.getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
            if (settings.authorized() && settings.paired() && RecoveryServiceList.canRestore(current,
                settings.prefs.getString("rebind_remaining", ""), System.currentTimeMillis(), settings.prefs.getLong("rebind_at", 0))) {
                boolean restored = Settings.Secure.putString(service.getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES, original);
                awaitingAccessibility = restored;
                settings.record(restored ? "已请求重启无障碍服务，等待系统绑定；控制保持暂停" : "无障碍服务未恢复，请在系统设置重新开启");
            } else settings.record("无障碍设置已变化或恢复已超时，请手动检查");
        } catch (RuntimeException denied) { settings.record("无障碍恢复被系统拒绝，请在系统设置重新开启"); }
        finally { clearRebind(); }
    }
    @Override public void close() {
        closed = true; main.removeCallbacksAndMessages(null);
        daemonProbe.shutdownNow();
        completeWifiRestart();
        // Roll back only our own short-lived edit, including when recovery is turned off mid-rebind.
        restoreOwnedRebind();
        if (registered) { connectivity.unregisterNetworkCallback(network); registered = false; }
        service.getContentResolver().unregisterContentObserver(observer);
    }
}
