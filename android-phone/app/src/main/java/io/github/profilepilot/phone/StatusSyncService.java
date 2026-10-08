package io.github.profilepilot.phone;

import android.app.*;
import android.content.*;
import android.content.pm.ServiceInfo;
import android.os.*;
import java.util.concurrent.*;
import org.json.JSONObject;

/** User-enabled status reporting, independent of the ADB/control service. */
public final class StatusSyncService extends Service {
  private final ScheduledExecutorService worker = Executors.newSingleThreadScheduledExecutor();
  private final Handler main = new Handler(Looper.getMainLooper());
  private ComputerStore store;
  private volatile boolean closed;
  private volatile boolean sending;
  static volatile String message = "尚未上报";
  static volatile long lastReportedAt;

  @Override public void onCreate() {
    super.onCreate(); store = new ComputerStore(this);
    getSystemService(NotificationManager.class).createNotificationChannel(new NotificationChannel("phone-status", "手机状态同步", NotificationManager.IMPORTANCE_LOW));
    startForeground(24, notification("准备上报手机状态…"), ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
    WirelessNetwork.start(this);
    worker.scheduleWithFixedDelay(this::sync, 0, 15, TimeUnit.SECONDS);
  }

  private Notification notification(String text) {
    PendingIntent open = PendingIntent.getActivity(this, 24, new Intent(this, MainActivity.class), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    PendingIntent stop = PendingIntent.getService(this, 25, new Intent(this, StatusSyncService.class).setAction("stop"), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    return new Notification.Builder(this, "phone-status").setSmallIcon(R.drawable.ic_phone).setContentTitle("ProfilePilot · 状态同步").setContentText(text)
        .setContentIntent(open).setOngoing(true).setOnlyAlertOnce(true).addAction(new Notification.Action.Builder(null, "停止同步", stop).build()).build();
  }

  private void sync() {
    if (closed || sending) return;
    sending = true;
    try {
      if (!store.statusEnabled()) { stopSelf(); return; }
      JSONObject link = store.statusLink(false);
      if (link == null) { store.statusEnabled(false); stopSelf(); return; }
      CompletableFuture<JSONObject> snapshot = new CompletableFuture<>();
      // Control state is owned by the main thread; reporting must never pulse its lease.
      main.post(() -> { try { snapshot.complete(StatusSyncClient.report(this)); } catch (Exception e) { snapshot.completeExceptionally(e); } });
      JSONObject report = snapshot.get(3, TimeUnit.SECONDS);
      if (closed || !store.statusEnabled()) return;
      StatusSyncClient.request(link, "report", link.getString("token"), new JSONObject().put("report", report));
      lastReportedAt = System.currentTimeMillis(); message = "已上报 · 无需连接电脑";
    } catch (Exception error) { message = "暂未上报，请检查网络或重新扫码"; }
    finally {
      sending = false;
      if (!closed) getSystemService(NotificationManager.class).notify(24, notification(message));
    }
  }

  @Override public int onStartCommand(Intent intent, int flags, int startId) {
    if (intent != null && "stop".equals(intent.getAction())) { store.statusEnabled(false); stopSelf(); }
    else worker.execute(this::sync);
    return START_NOT_STICKY;
  }
  @Override public IBinder onBind(Intent intent) { return null; }
  @Override public void onDestroy() { closed = true; WirelessNetwork.stop(); worker.shutdownNow(); main.removeCallbacksAndMessages(null); stopForeground(STOP_FOREGROUND_REMOVE); super.onDestroy(); }
}
