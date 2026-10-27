package io.github.profilepilot.phone;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Restores explicitly enabled services, never sessions or input. Credential-encrypted storage is required. */
public final class RecoveryReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        if (!Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction()) && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(intent.getAction())) return;
        RecoverySettings recovery = new RecoverySettings(context);
        if (!recovery.enabled()) return;
        if (recovery.paired()) start(context, ControlService.class, recovery);
        if (new ComputerStore(context).anyStatusEnabled()) start(context, StatusSyncService.class, recovery);
    }
    private void start(Context context, Class<?> service, RecoverySettings recovery) {
        try { context.startForegroundService(new Intent(context, service)); }
        catch (RuntimeException unavailable) { recovery.record("系统暂不允许后台启动，请打开 ProfilePilot 恢复连接服务"); }
    }
}
