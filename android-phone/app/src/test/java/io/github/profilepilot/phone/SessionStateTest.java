package io.github.profilepilot.phone;
import org.junit.Test;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;
import static org.junit.Assert.*;

public class SessionStateTest {
    private SessionState start(AtomicLong clock, String mode) {
        SessionState state = new SessionState(clock::get);
        state.start(state.instanceId, 0, UUID.randomUUID().toString(), mode, "computer", "agent", "task", 1000);
        return state;
    }
    @Test public void pauseInvalidatesQueuedInputAndLateCompletionCannotResume() {
        SessionState state = start(new AtomicLong(1), "control"); long before = state.generation;
        state.authorize(state.instanceId, state.sessionId, before, true); state.begin("tap");
        state.pause("phone takeover"); state.finish(before);
        assertEquals("paused", state.phase);
        assertThrows(IllegalStateException.class, () -> state.authorize(state.instanceId, state.sessionId, before, true));
        assertThrows(IllegalStateException.class, () -> state.authorize(state.instanceId, state.sessionId, state.generation, true));
    }
    @Test public void heartbeatAfterLostConnectionCannotRestoreControl() {
        AtomicLong clock = new AtomicLong(1); SessionState state = start(clock, "control");
        clock.addAndGet(SessionState.LEASE_MS); state.heartbeat();
        assertEquals("disconnected", state.phase);
        assertThrows(IllegalStateException.class, state::resume);
    }
    @Test public void viewSessionRejectsInputAndAllowsObservation() {
        SessionState state = start(new AtomicLong(1), "view");
        state.authorize(state.instanceId, state.sessionId, state.generation, false);
        assertThrows(IllegalStateException.class, () -> state.authorize(state.instanceId, state.sessionId, state.generation, true));
    }
    @Test public void endedSessionAndOldInstanceNeverAcceptInput() {
        SessionState state = start(new AtomicLong(1), "control"); String oldId = state.sessionId;
        state.stop("done"); assertThrows(IllegalStateException.class, state::resume);
        assertThrows(IllegalArgumentException.class, () -> state.start(state.instanceId, state.generation, oldId, "control", "pc", "agent", "task", 1000));
        state.start(state.instanceId, state.generation, UUID.randomUUID().toString(), "control", "pc", "agent", "task", 1000);
        assertThrows(IllegalStateException.class, () -> state.authorize("old-instance", state.sessionId, state.generation, true));
        assertThrows(IllegalStateException.class, () -> state.authorize(state.instanceId, oldId, state.generation, true));
    }
    @Test public void startCannotReplacePausedSessionAndResumeChangesGeneration() {
        SessionState state = start(new AtomicLong(1), "control"); state.pause("user"); long paused = state.generation;
        assertThrows(IllegalStateException.class, () -> state.start(state.instanceId, state.generation, UUID.randomUUID().toString(), "control", "pc", "agent", "", 1000));
        state.resume(); assertTrue(state.generation > paused); assertEquals("controlling", state.phase);
    }
    @Test public void taskStaysInProgressBetweenActionsAndShowsTheirActualAge() {
        AtomicLong clock = new AtomicLong(1); SessionState state = start(clock, "control");
        assertEquals("任务进行中", state.statusLabel());
        assertEquals("会话已就绪 · 可随时暂停", state.activityDescription());
        state.begin("获取屏幕画面");
        assertEquals("获取屏幕画面", state.statusLabel());
        state.finish(state.generation);
        assertEquals("任务进行中", state.statusLabel());
        assertEquals("最近：获取屏幕画面 · 刚刚", state.activityDescription());
        clock.addAndGet(6000); state.heartbeat();
        assertEquals("最近：获取屏幕画面 · 6 秒前", state.activityDescription());
        for (int i = 0; i < 60; i++) { clock.addAndGet(1000); state.heartbeat(); }
        assertEquals("最近：获取屏幕画面 · 1 分钟前", state.activityDescription());
        assertEquals("任务进行中", state.statusLabel());
    }
    @Test public void pauseAndDisconnectImmediatelyReplaceTheTaskPresentation() {
        AtomicLong clock = new AtomicLong(1); SessionState state = start(clock, "control");
        long version = state.generation;
        state.begin("点击控件"); state.pause("你已接管，电脑控制已暂停"); state.finish(version);
        assertEquals("已暂停 · 手机由你操作", state.statusLabel());
        assertEquals("你已接管，电脑控制已暂停", state.activityDescription());
        state.resume(); clock.addAndGet(SessionState.LEASE_MS); state.expire();
        assertEquals("电脑连接中断 · 已停止接受指令", state.statusLabel());
        assertEquals("电脑连接中断，已停止接受指令", state.activityDescription());
    }
    @Test public void newSessionClearsActionHistoryAndViewModeRemainsExplicit() {
        AtomicLong clock = new AtomicLong(1); SessionState state = start(clock, "control");
        state.begin("滚动页面"); state.finish(state.generation); state.stop("done");
        state.start(state.instanceId, state.generation, UUID.randomUUID().toString(), "view", "pc", "agent", "read", 1000);
        assertEquals("正在查看屏幕", state.statusLabel());
        assertEquals("会话已就绪 · 可随时暂停", state.activityDescription());
        state.stop("done");
        state.start(state.instanceId, state.generation, UUID.randomUUID().toString(), "control", "pc", "user", "", 1000);
        assertEquals("控制会话进行中", state.statusLabel());
    }
    @Test public void localResumeContinuesTheSameSessionWithoutReplayingOldInput() {
        AtomicLong clock = new AtomicLong(1); SessionState state = start(clock, "control");
        String id = state.sessionId; long previous = state.generation;
        state.pause("user"); long paused = state.generation;
        state.resumeFromPhone(state.instanceId, id, paused);
        assertEquals(id, state.sessionId);
        assertEquals("controlling", state.phase);
        assertTrue(state.generation > paused);
        assertThrows(IllegalStateException.class, () -> state.authorize(state.instanceId, id, previous, true));
        state.authorize(state.instanceId, id, state.generation, true);
    }
    @Test public void localResumeRequiresTheComputerToStillBeConnected() {
        AtomicLong clock = new AtomicLong(1); SessionState state = start(clock, "view");
        state.pause("user"); long paused = state.generation;
        clock.addAndGet(SessionState.LEASE_MS);
        assertThrows(IllegalStateException.class, () -> state.resumeFromPhone(state.instanceId, state.sessionId, paused));
        assertEquals("paused", state.phase); assertEquals(paused, state.generation);
        state.heartbeat();
        assertEquals("paused", state.phase);
        state.resumeFromPhone(state.instanceId, state.sessionId, paused);
        assertEquals("viewing", state.phase);
        assertThrows(IllegalStateException.class, () -> state.authorize(state.instanceId, state.sessionId, state.generation, true));
    }
    @Test public void staleResumeButtonsCannotResumeALaterPauseOrAnotherSession() {
        SessionState state = start(new AtomicLong(1), "control");
        state.pause("first pause"); long oldButtonVersion = state.generation; String oldSession = state.sessionId;
        state.resume(); state.pause("second pause");
        assertThrows(IllegalStateException.class, () -> state.resumeFromPhone(state.instanceId, oldSession, oldButtonVersion));
        assertEquals("paused", state.phase);
        state.stop("done");
        assertThrows(IllegalStateException.class, () -> state.resumeFromPhone(state.instanceId, oldSession, state.generation));
        state.start(state.instanceId, state.generation, UUID.randomUUID().toString(), "control", "pc", "next", "task", 1000);
        state.pause("new session");
        assertThrows(IllegalStateException.class, () -> state.resumeFromPhone(state.instanceId, oldSession, state.generation));
        assertThrows(IllegalStateException.class, () -> state.resumeFromPhone("old-instance", state.sessionId, state.generation));
        assertEquals("paused", state.phase);
    }
}
