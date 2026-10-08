package io.github.profilepilot.phone;

import android.app.*;
import android.content.*;
import android.content.pm.ServiceInfo;
import android.os.*;
import android.provider.Settings;
import org.json.JSONObject;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.*;

public final class ControlService extends Service {
    public static volatile ControlService current;
    final SessionState session = new SessionState(SystemClock::elapsedRealtime);
    final ConnectionState connection = new ConnectionState(SystemClock::elapsedRealtime);
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Map<String, Receipt> receipts = new LinkedHashMap<>();
    private record Receipt(String fingerprint, CompletableFuture<JSONObject> future) { }
    private PhoneServer server;
    private ControlOverlay overlay;
    private String lastNotification = "";
    private final BroadcastReceiver screenOff = new BroadcastReceiver() { @Override public void onReceive(Context context, Intent intent) { session.pause("手机已锁屏，控制已暂停"); render(); } };
    private final Runnable tick = new Runnable() { public void run() {
        session.expire();
        if (session.active() && (!Settings.canDrawOverlays(ControlService.this) || !getSystemService(NotificationManager.class).areNotificationsEnabled() || PhoneAccessibility.current == null)) session.pause("控制提示或操作权限已关闭");
        render(); main.postDelayed(this, 1000);
    } };
    @Override public void onCreate() {
        super.onCreate(); current = this;
        String token = getSharedPreferences("MainActivity", MODE_PRIVATE).getString("token", "");
        if (!token.matches("[a-f0-9]{64}")) { stopSelf(); return; }
        session.computer = getSharedPreferences("MainActivity", MODE_PRIVATE).getString("computer", "电脑");
        getSystemService(NotificationManager.class).createNotificationChannel(new NotificationChannel("control", "电脑控制状态", NotificationManager.IMPORTANCE_LOW));
        startForeground(1, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
        overlay = new ControlOverlay(this);
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(screenOff, new IntentFilter(Intent.ACTION_SCREEN_OFF), Context.RECEIVER_NOT_EXPORTED);
        else registerReceiver(screenOff, new IntentFilter(Intent.ACTION_SCREEN_OFF));
        try { server = new PhoneServer(token, this::handle); }
        catch (Exception error) { session.lastAction = "连接服务启动失败，请重试"; stopSelf(); return; }
        main.post(tick);
    }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ("pause".equals(intent.getAction()) || "resume".equals(intent.getAction()) || "stop".equals(intent.getAction()))) {
            localSessionControl(intent.getAction(), intent.getStringExtra("instanceId"), intent.getStringExtra("sessionId"), intent.getLongExtra("generation", -1));
        }
        return START_NOT_STICKY;
    }
    @Override public IBinder onBind(Intent intent) { return null; }
    private JSONObject handle(String method, JSONObject input) throws Exception {
        CompletableFuture<JSONObject> result = new CompletableFuture<>();
        main.post(() -> {
            try {
                session.expire();
                if (method.equals("sync")) {
                    connection.heartbeat(input.optString("transport", "unknown"));
                    connection.reportDebugSettings(input.optJSONObject("debugSettings"));
                    session.heartbeat(); result.complete(success(null));
                }
                else if (method.equals("start")) {
                    requireReady();
                    String computer = limited(input, "computer", 120);
                    if (!computer.equals(getSharedPreferences("MainActivity", MODE_PRIVATE).getString("computer", ""))) throw new IllegalStateException("控制电脑与配对记录不一致");
                    session.start(input.getString("instanceId"), input.getLong("generation"), input.getString("sessionId"), input.getString("mode"), computer, limited(input, "controller", 120), limited(input, "task", 500), System.currentTimeMillis());
                    receipts.clear(); render(); result.complete(success(null));
                } else if (method.equals("pause") || method.equals("resume") || method.equals("stop")) {
                    session.check(input.getString("instanceId"), input.getString("sessionId"), input.getLong("generation"));
                    if (method.equals("resume")) { requireReady(); session.resume(); }
                    else if (method.equals("pause")) session.pause("电脑已暂停控制"); else session.stop("电脑已结束控制");
                    render(); result.complete(success(null));
                } else if (method.equals("action")) action(input, result);
                else throw new IllegalArgumentException("不支持此控制请求");
            } catch (Exception error) { result.complete(failure(error)); }
        });
        // Timeout is uncertain to the caller. The receipt lets the SAME request
        // id be queried without sending duplicate input; no automatic replay.
        return result.get(6, TimeUnit.SECONDS);
    }
    private void action(JSONObject input, CompletableFuture<JSONObject> result) throws Exception {
        String requestId = input.getString("requestId");
        if (!requestId.matches("[a-fA-F0-9-]{36}")) throw new IllegalArgumentException("操作标识无效");
        String fingerprint = digest(input.toString());
        Receipt receipt = receipts.get(requestId);
        if (receipt != null) {
            if (!receipt.fingerprint.equals(fingerprint)) throw new IllegalStateException("操作标识已用于不同指令");
            receipt.future.thenAccept(result::complete); return;
        }
        if (receipts.size() >= 1000) throw new IllegalStateException("会话操作数已达上限，请结束后创建新会话");
        JSONObject action = input.getJSONObject("action"); String kind = action.getString("kind");
        boolean isInput = !kind.equals("snapshot") && !kind.equals("screenshot") && !kind.equals("find");
        requireReady();
        session.authorize(input.getString("instanceId"), input.getString("sessionId"), input.getLong("generation"), isInput);
        long generation = session.generation;
        receipts.put(requestId, new Receipt(fingerprint, result));
        session.begin(switch (kind) { case "tap", "click" -> "点击控件"; case "swipe", "scroll" -> "滚动页面"; case "text", "fill" -> "输入文字"; case "key" -> "执行导航按键"; case "snapshot", "find" -> "读取当前页面"; case "screenshot" -> "获取屏幕画面"; default -> "处理操作"; });
        render();
        PhoneAccessibility.current.perform(action).whenComplete((value, error) -> main.post(() -> {
            session.finish(generation); render(); result.complete(error == null ? success(value) : failure(error));
        }));
    }
    private void requireReady() {
        if (!Settings.canDrawOverlays(this)) throw new IllegalStateException("请在手机开启顶部胶囊权限");
        if (!getSystemService(NotificationManager.class).areNotificationsEnabled()) throw new IllegalStateException("请在手机开启控制状态通知");
        if (PhoneAccessibility.current == null) throw new IllegalStateException("请在手机启用 ProfilePilot 手机控制无障碍服务");
        if (getSystemService(KeyguardManager.class).isKeyguardLocked()) throw new IllegalStateException("请先解锁手机");
    }
    public void localControl(String command) {
        if (Looper.myLooper() != Looper.getMainLooper()) { main.post(() -> localControl(command)); return; }
        try {
            if (command.equals("resume")) {
                requireReady();
                session.resumeFromPhone(session.instanceId, session.sessionId, session.generation);
            } else if (command.equals("stop")) session.stop("你已在手机结束控制");
            else if (command.equals("pause")) session.pause("你已接管，电脑控制已暂停");
        } catch (IllegalStateException error) { localControlError(error); }
        render();
    }
    /** Bind a user click to the session and action displayed when the button was rendered. */
    Runnable pauseOrResumeAction() {
        String command = session.phase.equals("paused") ? "resume" : "pause";
        String instance = session.instanceId, id = session.sessionId;
        long version = session.generation;
        return () -> localSessionControl(command, instance, id, version);
    }
    private void localSessionControl(String command, String instance, String id, long version) {
        if (Looper.myLooper() != Looper.getMainLooper()) { main.post(() -> localSessionControl(command, instance, id, version)); return; }
        try { session.check(instance, id, version); }
        catch (IllegalStateException error) { localControlError(error); render(); return; }
        localControl(command);
    }
    private void localControlError(IllegalStateException error) {
        android.widget.Toast.makeText(this, error.getMessage(), android.widget.Toast.LENGTH_LONG).show();
    }
    JSONObject state() throws Exception {
        session.expire();
        PhoneReadiness readiness = new PhoneReadiness(this);
        return new JSONObject().put("protocol", 1).put("statusDeviceId", new ComputerStore(this).clientId()).put("instanceId", session.instanceId).put("sessionId", session.sessionId == null ? JSONObject.NULL : session.sessionId).put("generation", session.generation).put("phase", session.phase).put("mode", session.mode).put("computer", session.computer).put("controller", session.controller).put("task", session.task).put("startedAt", session.startedAt == 0 ? JSONObject.NULL : session.startedAt).put("lastAction", session.lastAction).put("permissions", new JSONObject().put("overlay", readiness.overlay).put("notifications", readiness.notifications).put("accessibility", readiness.accessibilityService.equals("running"))).put("readiness", readiness.json());
    }
    private JSONObject success(Object value) {
        try { return new JSONObject().put("ok", true).put("state", state()).put("result", value == null ? JSONObject.NULL : value); }
        catch (Exception error) { throw new IllegalStateException(error); }
    }
    private JSONObject failure(Throwable error) {
        try { return new JSONObject().put("ok", false).put("code", "PHONE_REJECTED").put("error", error.getMessage() == null ? "手机未完成操作" : error.getMessage()).put("state", state()); }
        catch (Exception ignored) { return new JSONObject(); }
    }
    String description() {
        String owner = session.controller.isBlank() ? session.computer : session.controller;
        return session.active() ? owner + " · " + session.statusLabel() : session.statusLabel();
    }
    private Notification notification() {
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder builder = new Notification.Builder(this, "control").setSmallIcon(R.drawable.ic_phone).setContentTitle(description()).setContentText(session.controller.isEmpty() ? "ProfilePilot 手机连接服务" : session.controller + (session.task.isEmpty() ? "" : " · " + session.task)).setContentIntent(open).setOngoing(true).setOnlyAlertOnce(true).setVisibility(Notification.VISIBILITY_PRIVATE);
        if (session.active()) builder.addAction(new Notification.Action.Builder(null, "暂停", commandIntent("pause", 1)).build());
        if (session.phase.equals("paused")) builder.addAction(new Notification.Action.Builder(null, "继续控制", commandIntent("resume", 3)).build());
        if (session.sessionId != null && !session.phase.equals("stopped")) builder.addAction(new Notification.Action.Builder(null, "结束控制", commandIntent("stop", 2)).build());
        return builder.build();
    }
    private PendingIntent commandIntent(String command, int id) {
        Intent intent = new Intent(this, ControlService.class).setAction(command)
            .setData(new android.net.Uri.Builder().scheme("profilepilot-control").authority(session.instanceId)
                .appendPath(session.sessionId == null ? "none" : session.sessionId).appendPath(Long.toString(session.generation)).appendPath(command).build())
            .putExtra("instanceId", session.instanceId).putExtra("sessionId", session.sessionId).putExtra("generation", session.generation);
        return PendingIntent.getService(this, id, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
    private void render() {
        if (overlay != null) overlay.update();
        String key = description() + session.controller + session.task + session.sessionId + session.generation;
        if (!key.equals(lastNotification)) { lastNotification = key; getSystemService(NotificationManager.class).notify(1, notification()); }
    }
    @Override public void onDestroy() {
        session.stop("连接服务已关闭"); main.removeCallbacksAndMessages(null); if (overlay != null) overlay.close();
        try { unregisterReceiver(screenOff); } catch (Exception ignored) { }
        if (server != null) try { server.close(); } catch (Exception ignored) { }
        current = null; super.onDestroy();
    }
    private static String limited(JSONObject input, String key, int max) throws Exception { String value = input.getString(key); if (value.length() > max) throw new IllegalArgumentException("文本超出长度限制"); return value; }
    private static String digest(String value) throws Exception { byte[] bytes = java.security.MessageDigest.getInstance("SHA-256").digest(value.getBytes(java.nio.charset.StandardCharsets.UTF_8)); StringBuilder hex = new StringBuilder(); for (byte b : bytes) hex.append(String.format(java.util.Locale.ROOT, "%02x", b & 255)); return hex.toString(); }
}
