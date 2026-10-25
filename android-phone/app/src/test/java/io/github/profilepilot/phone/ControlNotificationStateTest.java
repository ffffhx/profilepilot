package io.github.profilepilot.phone;

import static org.junit.Assert.*;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.Test;

public class ControlNotificationStateTest {
    private final AtomicLong now = new AtomicLong(1000);
    private final ConnectionState connection = new ConnectionState(now::get);
    private final SessionState session = new SessionState(now::get);

    private ControlNotificationState status() { return ControlNotificationState.from(connection, session); }
    private void start(String mode) {
        connection.heartbeat("wifi");
        session.start(session.instanceId, session.generation, UUID.randomUUID().toString(), mode,
            "My computer", "Codex", "检查通知状态", 1000);
    }

    @Test public void rememberedComputerIsNotAConnectionAndHeartbeatExpiresWithoutATask() {
        session.computer = "My computer";
        assertEquals(ControlNotificationState.Kind.WAITING, status().kind());
        assertEquals("等待电脑连接", status().title());
        assertFalse(status().canPause()); assertFalse(status().canResume()); assertFalse(status().canStop());
        connection.heartbeat("wifi");
        assertEquals("电脑已连接", status().title());
        now.addAndGet(SessionState.LEASE_MS);
        assertEquals(ControlNotificationState.Kind.DISCONNECTED, status().kind());
        assertEquals("电脑连接中断", status().title());
        assertFalse(status().canResume());
        connection.heartbeat("wifi");
        assertEquals(ControlNotificationState.Kind.CONNECTED, status().kind());
        assertNull(session.sessionId);
    }

    @Test public void usbWifiEmulatorAndOlderDesktopHeartbeatsShareTheSamePresentation() {
        for (String transport : new String[] {"usb", "wifi", "emulator", "unknown"}) {
            ConnectionState route = new ConnectionState(now::get);
            route.heartbeat(transport);
            assertEquals(ControlNotificationState.Kind.CONNECTED, ControlNotificationState.from(route, session).kind());
            now.addAndGet(SessionState.LEASE_MS);
            assertEquals(ControlNotificationState.Kind.DISCONNECTED, ControlNotificationState.from(route, session).kind());
        }
    }

    @Test public void oneExpiredTransportDoesNotHideAnotherLiveConnection() {
        connection.heartbeat("usb");
        now.addAndGet(4000); connection.heartbeat("wifi");
        now.addAndGet(4000);
        assertFalse(connection.connected("usb"));
        assertEquals(ControlNotificationState.Kind.CONNECTED, status().kind());
    }

    @Test public void activeModeStaysVisibleBetweenActionsWithoutNotificationChurn() {
        for (String mode : new String[] {"view", "control"}) {
            start(mode);
            ControlNotificationState original = status();
            assertEquals(mode.equals("view") ? "电脑正在查看" : "电脑正在控制", original.title());
            assertTrue(original.canPause()); assertFalse(original.canResume()); assertTrue(original.canStop());
            assertTrue(original.text().contains("My computer · Codex"));
            assertTrue(original.details().contains("检查通知状态"));
            session.begin("获取屏幕画面");
            assertEquals(original, status());
            session.finish(session.generation);
            assertEquals(original, status());
            session.stop("done");
        }
    }

    @Test public void pauseAndReconnectNeverResumeControlByUpdatingTheNotification() {
        start("control"); session.pause("user takeover");
        assertEquals("控制已暂停", status().title());
        assertFalse(status().canPause()); assertTrue(status().canResume()); assertTrue(status().canStop());
        now.addAndGet(SessionState.LEASE_MS);
        assertEquals(ControlNotificationState.Kind.DISCONNECTED, status().kind());
        assertFalse(status().canResume()); assertTrue(status().canStop());
        connection.heartbeat("wifi"); session.heartbeat();
        assertEquals(ControlNotificationState.Kind.PAUSED, status().kind());
        assertEquals("paused", session.phase);
        assertFalse(session.active());
    }

    @Test public void viewPauseIsExplicitAndDisconnectDoesNotOfferContinue() {
        start("view"); session.pause("pause");
        assertEquals("查看已暂停", status().title());
        now.addAndGet(SessionState.LEASE_MS);
        assertEquals("电脑连接中断", status().title());
        assertFalse(status().canResume());
    }

    @Test public void endedOrExpiredTasksDoNotLeakOldTaskDetailsIntoConnectedStatus() {
        for (boolean expire : new boolean[] {false, true}) {
            start("control");
            if (expire) {
                now.addAndGet(SessionState.LEASE_MS); session.expire();
                assertEquals(ControlNotificationState.Kind.DISCONNECTED, status().kind());
                connection.heartbeat("wifi"); session.heartbeat();
            } else session.stop("done");
            assertEquals(ControlNotificationState.Kind.CONNECTED, status().kind());
            assertTrue(status().text().contains("当前未控制手机"));
            assertFalse(status().details().contains("Codex"));
            assertFalse(status().details().contains("检查通知状态"));
            assertFalse(status().canPause()); assertFalse(status().canResume());
            assertFalse(status().canStop());
            assertFalse(session.active());
        }
    }
}
