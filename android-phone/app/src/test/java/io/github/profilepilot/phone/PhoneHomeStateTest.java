package io.github.profilepilot.phone;

import static org.junit.Assert.*;
import org.junit.Test;

public class PhoneHomeStateTest {
  private PhoneHomeState state(boolean connected, boolean debugging, boolean permissions,
      boolean unlocked, boolean seen, boolean session, String phase, String mode) {
    return PhoneHomeState.from(new PhoneHomeState.Input(connected, debugging, permissions,
        unlocked, seen, session, phase, mode));
  }

  @Test public void enabledDebuggingIsReadinessNotConnectionEvidence() {
    PhoneHomeState home=state(false,true,true,true,false,false,"idle","control");
    assertEquals(PhoneHomeState.Tone.NEUTRAL,home.tone());
    assertFalse(home.controls());
    assertEquals("等待电脑自动连接",home.title());
    assertEquals("还没有电脑连接",state(false,false,true,true,false,false,"idle","control").title());
  }

  @Test public void connectionDoesNotImplyAnActiveControlSession() {
    PhoneHomeState home=state(true,true,true,true,true,false,"idle","control");
    assertEquals(PhoneHomeState.Tone.CONNECTED,home.tone());
    assertFalse(home.controls());
    assertEquals("电脑已连接",home.title());
  }

  @Test public void permissionLossDoesNotHideARealComputerConnection() {
    PhoneHomeState home=state(true,true,false,true,true,false,"idle","control");
    assertEquals(PhoneHomeState.Tone.CONNECTED,home.tone());
    assertTrue(home.description().contains("权限"));
    assertFalse(home.controls());
  }

  @Test public void missingHeartbeatHidesControlsEvenWhenSessionStillLooksActive() {
    for (String phase:new String[]{"controlling","viewing","executing","paused"}) {
      PhoneHomeState home=state(false,true,true,true,true,true,phase,"control");
      assertEquals(PhoneHomeState.Tone.ATTENTION,home.tone());
      assertEquals("电脑连接中断",home.title());
      assertFalse(home.controls());
    }
  }

  @Test public void reconnectionNeverOffersToResumeAnExpiredSession() {
    PhoneHomeState home=state(true,true,true,true,true,true,"disconnected","control");
    assertEquals(PhoneHomeState.Tone.CONNECTED,home.tone());
    assertFalse(home.controls());
    assertFalse(home.paused());
  }

  @Test public void viewAndControlHaveDifferentAuthorityDescriptions() {
    PhoneHomeState view=state(true,true,true,true,true,true,"viewing","view");
    PhoneHomeState control=state(true,true,true,true,true,true,"controlling","control");
    assertTrue(view.controls()); assertTrue(view.viewing());
    assertTrue(view.description().contains("不能点击"));
    assertTrue(control.controls()); assertFalse(control.viewing());
    assertEquals(PhoneHomeState.Tone.ACTIVE,control.tone());
  }

  @Test public void pausedSessionRemainsPausedAndExplainsMissingReadiness() {
    PhoneHomeState locked=state(true,true,true,false,true,true,"paused","control");
    assertTrue(locked.paused()); assertTrue(locked.controls());
    assertTrue(locked.description().contains("解锁"));
    PhoneHomeState permissions=state(true,true,false,true,true,true,"paused","view");
    assertTrue(permissions.paused()); assertTrue(permissions.viewing());
    assertTrue(permissions.description().contains("权限"));
  }
}
