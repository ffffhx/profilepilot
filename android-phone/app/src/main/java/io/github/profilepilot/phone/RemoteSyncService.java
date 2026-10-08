package io.github.profilepilot.phone;

import android.app.*;
import android.content.*;
import android.content.pm.ServiceInfo;
import android.os.*;
import java.util.concurrent.*;
import org.json.*;

/** Explicitly enabled ongoing connection to the user's paired computers. */
public final class RemoteSyncService extends Service {
  static volatile boolean running;
  private final ScheduledExecutorService worker = Executors.newSingleThreadScheduledExecutor();
  private ComputerStore store;
  private volatile boolean closed;

  @Override
  public void onCreate() {
    super.onCreate();
    running = true;
    store = new ComputerStore(this);
    NotificationManager manager = getSystemService(NotificationManager.class);
    manager.createNotificationChannel(
        new NotificationChannel("mobile-connection", "电脑连接", NotificationManager.IMPORTANCE_LOW));
    manager.createNotificationChannel(
        new NotificationChannel("mobile-tasks", "任务进度与确认", NotificationManager.IMPORTANCE_DEFAULT));
    startForeground(20, ongoing("正在连接你的电脑…"), ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
    worker.scheduleWithFixedDelay(this::sync, 0, 8, TimeUnit.SECONDS);
  }

  private Notification ongoing(String message) {
    PendingIntent open =
        PendingIntent.getActivity(
            this,
            20,
            new Intent(this, MainActivity.class),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    PendingIntent stop =
        PendingIntent.getService(
            this,
            21,
            new Intent(this, RemoteSyncService.class).setAction("stop"),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    return new Notification.Builder(this, "mobile-connection")
        .setSmallIcon(R.drawable.ic_phone)
        .setContentTitle("ProfilePilot · 移动工作区")
        .setContentText(message)
        .setContentIntent(open)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .addAction(new Notification.Action.Builder(null, "停止后台连接", stop).build())
        .build();
  }

  private void sync() {
    if (closed) return;
    try {
      JSONArray computers = store.all();
      int online = 0;
      if (computers.length() == 0) {
        store.notifications(false);
        stopSelf();
        return;
      }
      SharedPreferences seen = getSharedPreferences("mobile-notification-state", MODE_PRIVATE);
      for (int i = 0; i < computers.length() && !closed; i++) {
        JSONObject computer = computers.getJSONObject(i);
        String pc = computer.getString("id");
        try {
          JSONObject data = RemoteClient.read(computer, RemoteClient.object("action", "sync"));
          online++;
          JSONArray tasks = data.getJSONArray("tasks");
          boolean initialized = seen.getBoolean("initialized:" + pc, false);
          for (int j = 0; j < tasks.length(); j++) {
            JSONObject task = tasks.getJSONObject(j);
            String id = task.getString("id"),
                status = task.getString("status"),
                key = pc + ":" + id;
            JSONObject pending = task.optJSONObject("pending");
            String marker = pending != null ? pending.optString("id") : status;
            String old = seen.getString(key, "");
            boolean complete =
                status.equals("completed") || status.equals("failed") || status.equals("partial");
            if (!marker.equals(old)
                && (pending != null || initialized && complete)
                && store.find(pc) != null
                && !closed) {
              Intent target =
                  new Intent(this, MainActivity.class)
                      .putExtra("computerId", pc)
                      .putExtra("taskId", id)
                      .setData(android.net.Uri.parse("profilepilot://task/" + pc + "/" + id));
              PendingIntent open =
                  PendingIntent.getActivity(
                      this,
                      key.hashCode(),
                      target,
                      PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
              Notification notification =
                  new Notification.Builder(this, "mobile-tasks")
                      .setSmallIcon(R.drawable.ic_phone)
                      .setContentTitle(
                          pending != null ? "任务需要你的确认" : "任务" + MainActivity.statusLabel(status))
                      .setContentText(task.optString("title"))
                      .setSubText(computer.optString("name"))
                      .setContentIntent(open)
                      .setAutoCancel(true)
                      .setVisibility(Notification.VISIBILITY_PRIVATE)
                      .build();
              if (getSystemService(NotificationManager.class).areNotificationsEnabled())
                getSystemService(NotificationManager.class).notify(key.hashCode(), notification);
            }
            seen.edit().putString(key, marker).apply();
          }
          seen.edit().putBoolean("initialized:" + pc, true).apply();
        } catch (Exception ignored) {
          /* PC offline: retain identity and retry; never replay mutations. */
        }
      }
      if (!closed)
        getSystemService(NotificationManager.class)
            .notify(20, ongoing(online > 0 ? online + " 台电脑已连接 · 等待任务动态" : "电脑暂不可达 · 将自动重连"));
    } catch (Exception ignored) {
      if (!closed)
        getSystemService(NotificationManager.class).notify(20, ongoing("连接信息不可用，请打开 App 检查"));
    }
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    if (intent != null && "stop".equals(intent.getAction())) {
      store.notifications(false);
      stopSelf();
    }
    return START_NOT_STICKY;
  }

  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }

  @Override
  public void onDestroy() {
    running = false;
    closed = true;
    worker.shutdownNow();
    stopForeground(STOP_FOREGROUND_REMOVE);
    super.onDestroy();
  }
}
