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
    private final ScreenshotTransfer screenshots = new ScreenshotTransfer(session, SystemClock::elapsedRealtime);
    private record Receipt(String fingerprint, CompletableFuture<JSONObject> future) { }
    private PhoneServer server;
    private ControlOverlay overlay;
    private AutomaticRecovery recovery;
    private String lastNotification = "";
    private long followSequence;
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
        // DEFAULT keeps the icon visible when the system hides low-importance notifications.
        // Channel settings remain user-owned on upgrades; never recreate a channel to override them.
        NotificationChannel channel = new NotificationChannel("control", "连接与控制状态", NotificationManager.IMPORTANCE_DEFAULT);
        channel.setSound(null, null);
        channel.enableVibration(false);
        channel.setDescription("在顶部状态栏显示连接、查看、控制或暂停图标，下拉可查看详情并暂停或结束控制");
        getSystemService(NotificationManager.class).createNotificationChannel(channel);
        startForeground(1, notification(ControlNotificationState.from(connection, session)), ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
        overlay = new ControlOverlay(this);
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(screenOff, new IntentFilter(Intent.ACTION_SCREEN_OFF), Context.RECEIVER_NOT_EXPORTED);
        else registerReceiver(screenOff, new IntentFilter(Intent.ACTION_SCREEN_OFF));
        try { server = new PhoneServer(token, this::handle); }
        catch (Exception error) { session.lastAction = "连接服务启动失败，请重试"; stopSelf(); return; }
        main.post(tick);
        LanDiscovery.acquire(this);
    }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ("pause".equals(intent.getAction()) || "resume".equals(intent.getAction()) || "stop".equals(intent.getAction()))) {
            localSessionControl(intent.getAction(), intent.getStringExtra("instanceId"), intent.getStringExtra("sessionId"), intent.getLongExtra("generation", -1));
        }
        RecoverySettings settings = new RecoverySettings(this);
        if ((settings.advanced() || settings.accessibilityOn()) && settings.paired()) {
            if (recovery == null) recovery = new AutomaticRecovery(this);
        } else if (recovery != null) { recovery.close(); recovery = null; }
        if (intent == null && settings.enabled()) settings.record("系统已重启连接服务；旧控制会话未恢复");
        return settings.enabled() && settings.paired() && server != null ? START_STICKY : START_NOT_STICKY;
    }
    @Override public IBinder onBind(Intent intent) { return null; }
    private JSONObject handle(String method, JSONObject input, ControlTiming timing) throws Exception {
        CompletableFuture<JSONObject> result = new CompletableFuture<>();
        timing.mark("mainQueued");
        main.post(() -> {
            timing.mark("main");
            try {
                session.expire();
                if (method.equals("sync")) {
                    connection.heartbeat(input.optString("transport", "unknown"));
                    connection.reportDebugSettings(input.optJSONObject("debugSettings"));
                    session.heartbeat(); render(); result.complete(success(null, timing));
                }
                else if (method.equals("accessibility-recovery")) {
                    if (!session.phase.equals("idle") && !session.phase.equals("stopped")) throw new IllegalStateException("请先结束当前手机任务，再恢复无障碍服务");
                    RecoverySettings settings = new RecoverySettings(this);
                    if (input.getString("op").equals("repair")) {
                        AccessibilityRecovery.enable(this);
                        if (input.has("autoRestore")) {
                            boolean value = input.getBoolean("autoRestore");
                            if (value) settings.enabled(true);
                            settings.accessibilityOn(value);
                            startForegroundService(new Intent(this, ControlService.class));
                        }
                        settings.record("电脑已请求开启无障碍服务；旧控制会话未恢复");
                        AccessibilityRecovery.rebind(this);
                    } else if (!input.getString("op").equals("status")) throw new IllegalArgumentException("未知恢复操作");
                    result.complete(success(new JSONObject().put("authorized", settings.authorized()).put("autoRestore", settings.accessibilityOn()).put("enabled", AccessibilityRecovery.enabled(this))));
                }
                else if (method.equals("camera")) {
                    // Read-only lease check for the shell-owned virtual camera. It must not keep
                    // a crashed desktop's lease alive or resume a paused phone session.
                    requireReady();
                    session.check(input.getString("instanceId"), input.getString("sessionId"), input.getLong("generation"));
                    if (!session.active() || !session.mode.equals("control")) throw new IllegalStateException("手机控制已暂停或结束，屏幕摄像头已停止");
                    result.complete(success(null));
                }
                else if (method.equals("start")) {
                    requireReady();
                    String computer = limited(input, "computer", 120);
                    if (!computer.equals(getSharedPreferences("MainActivity", MODE_PRIVATE).getString("computer", ""))) throw new IllegalStateException("控制电脑与配对记录不一致");
                    PhoneAccessibility.current.resetFollowTouch();
                    session.start(input.getString("instanceId"), input.getLong("generation"), input.getString("sessionId"), input.getString("mode"), computer, limited(input, "controller", 120), limited(input, "task", 500), System.currentTimeMillis());
                    receipts.clear(); screenshots.clear(); followSequence = 0;
                    render(); result.complete(success(null));
                } else if (method.equals("pause") || method.equals("resume") || method.equals("stop")) {
                    session.check(input.getString("instanceId"), input.getString("sessionId"), input.getLong("generation"));
                    if (method.equals("resume")) { requireReady(); session.resume(); }
                    else if (method.equals("pause")) session.pause("电脑已暂停控制"); else session.stop("电脑已结束控制");
                    render(); result.complete(success(null));
                } else if (method.equals("follow")) follow(input, result, timing);
                else if (method.equals("screenshot-chunk")) {
                    requireReady();
                    result.complete(success(screenshots.read(input.getString("instanceId"), input.getString("sessionId"),
                        input.getLong("generation"), input.getString("transferId"), input.getInt("offset")), timing));
                }
                else if (method.equals("action")) action(input, result, timing);
                else throw new IllegalArgumentException("不支持此控制请求");
            } catch (Exception error) { result.complete(failure(error)); }
        });
        // Timeout is uncertain to the caller. The receipt lets the SAME request
        // id be queried without sending duplicate input; no automatic replay.
        return result.get(6, TimeUnit.SECONDS);
    }
    private void follow(JSONObject input, CompletableFuture<JSONObject> result, ControlTiming timing) throws Exception {
        requireReady();
        timing.mark("ready");
        String op = input.getString("op");
        session.authorize(input.getString("instanceId"), input.getString("sessionId"), input.getLong("generation"), op.equals("touch"));
        if (op.equals("probe")) {
            result.complete(success(new JSONObject().put("protocol", 1).put("cameraFrameProvenance", 1)
                .put("cameraPointChange", FollowTouch.CAMERA_POINT_CHANGE)
                .put("cameraRepressGapMs", FollowTouch.CAMERA_REPRESS_GAP_MS), timing)); return;
        }
        if (op.equals("touch")) {
            long sequence = input.getLong("sequence");
            if (sequence <= followSequence) throw new IllegalStateException("持续触控指令已过期，不会重放");
            followSequence = sequence;
            String instance = session.instanceId, id = session.sessionId;
            long generation = session.generation;
            PhoneAccessibility.current.followTouch(input, () -> {
                session.expire();
                return session.active() && session.mode.equals("control") && instance.equals(session.instanceId)
                    && id.equals(session.sessionId) && generation == session.generation;
            });
            // Accepted is receipt, not dispatchGesture completion. Camera use
            // requires a subsequent frame's applied-at-capture proof.
            result.complete(success(new JSONObject().put("accepted", true).put("acceptedSequence", sequence), timing)); return;
        }
        if (!op.equals("frame")) throw new IllegalArgumentException("未知视觉跟随请求");
        ScreenshotRegion region = input.has("region") ? ScreenshotRegion.from(input.getJSONObject("region")) : null;
        boolean chunkedFrame = ScreenshotTransfer.PROTOCOL.equals(input.optString("imageTransfer"));
        int cameraProvenance = input.optInt("cameraFrameProvenance", 0);
        if (cameraProvenance != 0 && cameraProvenance != 1) throw new IllegalArgumentException("不支持此镜头画面凭据版本");
        if (cameraProvenance == 1 && region != null) throw new IllegalArgumentException("镜头定位需要完整画面");
        long generation = session.generation;
        session.begin("视觉跟随 · 获取画面");
        PhoneAccessibility.current.perform(new JSONObject().put("kind", "screenshot").put("nativeSize", true)
            .put("cameraFrameProvenance", cameraProvenance), timing, region).whenComplete((value, error) -> main.post(() -> {
            timing.mark("captureDone");
            session.finish(generation); render(); timing.mark("rendered");
            try {
                if (error != null) result.complete(failure(error));
                else {
                    Object output = chunkedFrame ? screenshots.offerIfLarge((JSONObject) value,
                        input.getString("instanceId"), input.getString("sessionId"), generation) : value;
                    result.complete(success(output, timing));
                }
            } catch (Exception failure) { result.complete(failure(failure)); }
        }));
    }
    private void action(JSONObject input, CompletableFuture<JSONObject> result, ControlTiming timing) throws Exception {
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
        boolean chunkedScreenshot = kind.equals("screenshot") && action.optString("format").equals("png")
            && ScreenshotTransfer.PROTOCOL.equals(input.optString("imageTransfer"));
        boolean isInput = !kind.equals("snapshot") && !kind.equals("screenshot") && !kind.equals("find");
        requireReady();
        session.authorize(input.getString("instanceId"), input.getString("sessionId"), input.getLong("generation"), isInput);
        long generation = session.generation;
        receipts.put(requestId, new Receipt(fingerprint, result));
        session.begin(switch (kind) { case "tap", "click" -> "点击控件"; case "swipe", "scroll" -> "滚动页面"; case "text", "fill" -> "输入文字"; case "key" -> "执行导航按键"; case "snapshot", "find" -> "读取当前页面"; case "screenshot" -> "获取屏幕画面"; default -> "处理操作"; });
        render();
        PhoneAccessibility.current.perform(action, timing).whenComplete((value, error) -> main.post(() -> {
            timing.mark("actionDone");
            session.finish(generation); render();
            try {
                if (error != null) result.complete(failure(error));
                else {
                    Object output = chunkedScreenshot ? screenshots.offer((JSONObject) value,
                        input.getString("instanceId"), input.getString("sessionId"), generation) : value;
                    result.complete(success(output, timing));
                }
            } catch (Exception failure) { result.complete(failure(failure)); }
        }));
    }
    private void requireReady() {
        if (!Settings.canDrawOverlays(this)) throw new IllegalStateException("请在手机开启顶部胶囊权限");
        if (!getSystemService(NotificationManager.class).areNotificationsEnabled()) throw new IllegalStateException("请在手机开启控制状态通知");
        if (PhoneAccessibility.current == null) throw new IllegalStateException("请在手机启用 "+getString(R.string.accessibility_name)+"无障碍服务");
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
        return sessionControlAction(session.phase.equals("paused") ? "resume" : "pause");
    }
    Runnable sessionControlAction(String command) {
        if (!command.equals("pause") && !command.equals("resume") && !command.equals("stop")) throw new IllegalArgumentException("不支持的会话操作");
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
        return state(null);
    }
    private JSONObject state(ControlTiming timing) throws Exception {
        session.expire();
        if (timing != null) timing.mark("stateStart");
        PhoneReadiness readiness = new PhoneReadiness(this);
        if (timing != null) timing.mark("readiness");
        String deviceId = new ComputerStore(this).clientId();
        if (timing != null) timing.mark("identity");
        JSONObject value = new JSONObject().put("protocol", 1).put("statusDeviceId", deviceId).put("instanceId", session.instanceId).put("sessionId", session.sessionId == null ? JSONObject.NULL : session.sessionId).put("generation", session.generation).put("phase", session.phase).put("mode", session.mode).put("computer", session.computer).put("controller", session.controller).put("task", session.task).put("startedAt", session.startedAt == 0 ? JSONObject.NULL : session.startedAt).put("lastAction", session.lastAction).put("permissions", new JSONObject().put("overlay", readiness.overlay).put("notifications", readiness.notifications).put("accessibility", readiness.accessibilityService.equals("running"))).put("readiness", readiness.json());
        if (timing != null) timing.mark("stateDone");
        return value;
    }
    private JSONObject success(Object value) {
        return success(value, null);
    }
    private JSONObject success(Object value, ControlTiming timing) {
        try { return new JSONObject().put("ok", true).put("state", state(timing)).put("result", value == null ? JSONObject.NULL : value); }
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
    private Notification notification(ControlNotificationState status) {
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        int icon = switch (status.kind()) {
            case WAITING -> R.drawable.ic_notification;
            case CONNECTED -> R.drawable.ic_status_connected;
            case VIEWING -> R.drawable.ic_status_viewing;
            case CONTROLLING -> R.drawable.ic_status_controlling;
            case PAUSED -> R.drawable.ic_status_paused;
            case DISCONNECTED -> R.drawable.ic_status_disconnected;
        };
        Notification.Builder builder = new Notification.Builder(this, "control").setSmallIcon(icon)
            .setContentTitle(status.title()).setContentText(status.text())
            .setStyle(new Notification.BigTextStyle().bigText(status.details()))
            .setContentIntent(open).setOngoing(true).setOnlyAlertOnce(true).setShowWhen(false)
            .setCategory(Notification.CATEGORY_SERVICE).setVisibility(Notification.VISIBILITY_PRIVATE);
        if (Build.VERSION.SDK_INT >= 31) builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE);
        if (status.canPause()) builder.addAction(new Notification.Action.Builder(null, "暂停", commandIntent("pause", 1)).build());
        if (status.canResume()) builder.addAction(new Notification.Action.Builder(null, session.mode.equals("view") ? "继续查看" : "继续控制", commandIntent("resume", 3)).build());
        if (status.canStop()) builder.addAction(new Notification.Action.Builder(null, session.mode.equals("view") ? "结束查看" : "结束控制", commandIntent("stop", 2)).build());
        return builder.build();
    }
    private PendingIntent commandIntent(String command, int id) {
        Intent intent = new Intent(this, ControlService.class).setAction(command)
            .setData(new android.net.Uri.Builder().scheme("profilepilot-control").authority(session.instanceId)
                .appendPath(session.sessionId == null ? "none" : session.sessionId).appendPath(Long.toString(session.generation)).appendPath(command).build())
            .putExtra("instanceId", session.instanceId).putExtra("sessionId", session.sessionId).putExtra("generation", session.generation);
        return PendingIntent.getService(this, id, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
    void refreshPresentation() { render(); }
    private void render() {
        screenshots.prune();
        if (!session.active() && PhoneAccessibility.current != null) PhoneAccessibility.current.releaseFollowTouch();
        if (overlay != null) overlay.update();
        ControlNotificationState status = ControlNotificationState.from(connection, session);
        String key = status.toString() + session.instanceId + session.sessionId + session.generation;
        if (!key.equals(lastNotification)) { lastNotification = key; getSystemService(NotificationManager.class).notify(1, notification(status)); }
    }
    @Override public void onDestroy() {
        LanDiscovery.release(this);
        screenshots.clear();
        if (recovery != null) { recovery.close(); recovery = null; }
        if (PhoneAccessibility.current != null) PhoneAccessibility.current.releaseFollowTouch();
        session.stop("连接服务已关闭"); main.removeCallbacksAndMessages(null); if (overlay != null) overlay.close();
        try { unregisterReceiver(screenOff); } catch (Exception ignored) { }
        if (server != null) try { server.close(); } catch (Exception ignored) { }
        current = null; super.onDestroy();
    }
    private static String limited(JSONObject input, String key, int max) throws Exception { String value = input.getString(key); if (value.length() > max) throw new IllegalArgumentException("文本超出长度限制"); return value; }
    private static String digest(String value) throws Exception { byte[] bytes = java.security.MessageDigest.getInstance("SHA-256").digest(value.getBytes(java.nio.charset.StandardCharsets.UTF_8)); StringBuilder hex = new StringBuilder(); for (byte b : bytes) hex.append(String.format(java.util.Locale.ROOT, "%02x", b & 255)); return hex.toString(); }
}
