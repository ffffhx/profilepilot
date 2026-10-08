package io.github.profilepilot.phone;

import java.util.UUID;
import java.util.function.LongSupplier;

/** The phone owns the lease. A connection heartbeat never grants control. */
public final class SessionState {
    public static final long LEASE_MS = 8000;
    public final String instanceId = UUID.randomUUID().toString();
    public String sessionId = null, phase = "idle", mode = "view", computer = "", controller = "", task = "", lastAction = "";
    public long generation = 0, startedAt = 0, lastHeartbeat = 0;
    private String lastPhoneAction = "";
    private long lastPhoneActionAt;
    private final LongSupplier clock;
    public SessionState(LongSupplier clock) { this.clock = clock; }
    public synchronized boolean active() { return phase.equals("controlling") || phase.equals("viewing") || phase.equals("executing"); }
    public synchronized void heartbeat() { expire(); lastHeartbeat = clock.getAsLong(); }
    public synchronized void expire() {
        if (active() && clock.getAsLong() - lastHeartbeat >= LEASE_MS) {
            generation++; phase = "disconnected"; lastAction = "电脑连接中断，已停止接受指令";
        }
    }
    public synchronized void check(String instance, String session, long version) {
        expire();
        if (!instanceId.equals(instance) || generation != version || sessionId == null || !sessionId.equals(session)) throw new IllegalStateException("会话已改变，请重新读取状态，不要重放操作");
    }
    public synchronized void start(String instance, long version, String session, String nextMode, String host, String owner, String title, long wallTime) {
        expire();
        if (!instanceId.equals(instance) || generation != version || active() || phase.equals("paused")) throw new IllegalStateException("已有会话或状态已改变，请先结束原会话");
        if (session == null || session.equals(sessionId) || !session.matches("[a-fA-F0-9-]{36}")) throw new IllegalArgumentException("无效的新会话标识");
        if (!nextMode.equals("view") && !nextMode.equals("control")) throw new IllegalArgumentException("控制模式无效");
        sessionId = session; mode = nextMode; computer = host; controller = owner; task = title;
        generation++; phase = mode.equals("view") ? "viewing" : "controlling"; startedAt = wallTime; lastHeartbeat = clock.getAsLong(); lastAction = "会话已开始";
        lastPhoneAction = ""; lastPhoneActionAt = 0;
    }
    public synchronized void pause(String reason) { if (active()) { generation++; phase = "paused"; lastAction = reason; } }
    public synchronized void stop(String reason) { if (sessionId != null && !phase.equals("stopped")) { generation++; phase = "stopped"; lastAction = reason; } }
    public synchronized void resume() {
        expire(); if (!phase.equals("paused")) throw new IllegalStateException("仅暂停的会话可以恢复；断线或结束后需要新建会话");
        generation++; phase = mode.equals("view") ? "viewing" : "controlling"; lastHeartbeat = clock.getAsLong(); lastAction = "会话已恢复";
    }
    public synchronized void resumeFromPhone(String instance, String session, long version) {
        check(instance, session, version);
        if (clock.getAsLong() - lastHeartbeat >= LEASE_MS) throw new IllegalStateException("电脑连接已中断，请先恢复连接，再点击继续");
        resume();
    }
    public synchronized void authorize(String instance, String session, long version, boolean input) {
        check(instance, session, version);
        if (!active()) throw new IllegalStateException("手机已暂停、结束或断开，拒绝后续操作");
        if (input && !mode.equals("control")) throw new IllegalStateException("仅查看会话不能输入");
        if (phase.equals("executing")) throw new IllegalStateException("前一项操作尚未完成");
    }
    public synchronized void begin(String description) { phase = "executing"; lastAction = description; lastPhoneAction = description; lastPhoneActionAt = clock.getAsLong(); }
    public synchronized void finish(long version) {
        if (generation == version && phase.equals("executing")) {
            phase = mode.equals("view") ? "viewing" : "controlling";
            lastPhoneActionAt = clock.getAsLong();
        }
    }
    /** Describe the known session, without guessing whether an external model is thinking. */
    public synchronized String statusLabel() {
        return switch (phase) {
            case "viewing" -> "正在查看屏幕";
            case "controlling" -> task.isBlank() ? "控制会话进行中" : "任务进行中";
            case "executing" -> lastAction;
            case "paused" -> "已暂停 · 手机由你操作";
            case "stopped" -> "控制已结束";
            case "disconnected" -> "电脑连接中断 · 已停止接受指令";
            default -> "已连接，未控制";
        };
    }
    public synchronized String activityDescription() {
        if (!active()) return lastAction;
        if (phase.equals("executing")) return "正在执行手机操作";
        if (lastPhoneAction.isEmpty()) return "会话已就绪 · 可随时暂停";
        long seconds = Math.max(0, clock.getAsLong() - lastPhoneActionAt) / 1000;
        String elapsed = seconds < 3 ? "刚刚" : seconds < 60 ? seconds + " 秒前"
            : seconds < 3600 ? seconds / 60 + " 分钟前" : seconds / 3600 + " 小时前";
        return "最近：" + lastPhoneAction + " · " + elapsed;
    }
}
