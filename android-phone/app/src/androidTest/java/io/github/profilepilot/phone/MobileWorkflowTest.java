package io.github.profilepilot.phone;

import static org.junit.Assert.*;

import android.app.Dialog;
import android.app.Instrumentation;
import android.content.Context;
import android.content.ComponentName;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.os.Build;
import android.os.SystemClock;
import android.view.View;
import android.view.ViewGroup;
import android.widget.TextView;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.io.FileOutputStream;
import java.lang.reflect.Field;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Run only on a disposable emulator; no Android permission is granted by these tests. */
@RunWith(AndroidJUnit4.class)
public class MobileWorkflowTest {
  private final Instrumentation instrumentation=InstrumentationRegistry.getInstrumentation();
  private final Context context=instrumentation.getTargetContext();
  private static final String TEST_TOKEN="a".repeat(64);

  private SharedPreferences pairing() { return context.getSharedPreferences("MainActivity",Context.MODE_PRIVATE); }
  @Before public void resetFixture() throws Exception {
    assertTrue("Use a disposable emulator",Build.HARDWARE.contains("ranchu") || Build.HARDWARE.contains("goldfish"));
    context.stopService(new Intent(context,ControlService.class));
    context.stopService(new Intent(context,StatusSyncService.class));
    new ComputerStore(context).statusEnabled(false);
    pairing().edit().clear().commit();
    until(() -> ControlService.current==null);
  }
  @After public void stopFixture() { context.stopService(new Intent(context,ControlService.class)); pairing().edit().clear().commit(); }
  private interface Check { boolean get() throws Exception; }
  private void until(Check check) throws Exception {
    long deadline=SystemClock.elapsedRealtime()+15000;
    while (SystemClock.elapsedRealtime()<deadline) { if (check.get()) return; SystemClock.sleep(100); }
    fail("Timed out waiting for phone home state");
  }
  private View find(View view,String text) {
    if (view instanceof TextView label && text.contentEquals(label.getText())) return view;
    if (view instanceof ViewGroup group) for (int i=0;i<group.getChildCount();i++) {
      View found=find(group.getChildAt(i),text); if (found!=null) return found;
    }
    return null;
  }
  private Dialog sheet(MainActivity activity) {
    try { Field field=MainActivity.class.getDeclaredField("sheet"); field.setAccessible(true); return (Dialog)field.get(activity); }
    catch (ReflectiveOperationException error) { throw new AssertionError(error); }
  }
  private String status(MainActivity activity) { return ((TextView)activity.findViewById(R.id.home_status)).getText().toString(); }
  private void awaitTitle(ActivityScenario<MainActivity> scenario,String title) throws Exception {
    until(() -> { AtomicBoolean matched=new AtomicBoolean(); scenario.onActivity(a -> matched.set(title.equals(status(a)))); return matched.get(); });
  }
  private void screen(String name) throws Exception {
    instrumentation.waitForIdleSync(); SystemClock.sleep(300);
    Bitmap bitmap=instrumentation.getUiAutomation().takeScreenshot(); assertNotNull(bitmap);
    File root=new File(context.getFilesDir(),"mobile-verification"); assertTrue(root.isDirectory() || root.mkdirs());
    try (FileOutputStream output=new FileOutputStream(new File(root,name+".png"))) { bitmap.compress(Bitmap.CompressFormat.PNG,100,output); }
    bitmap.recycle();
  }

  @Test public void homeKeepsBothDebuggingRoutesAndOnlyHomeNavigation() throws Exception {
    try (ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)) {
      scenario.onActivity(a -> {
        View root=a.getWindow().getDecorView();
        for (String removed:new String[]{"任务","Agent","设备","我的","连接电脑"}) assertNull(removed,find(root,removed));
        assertNotNull(a.findViewById(R.id.home_usb)); assertNotNull(a.findViewById(R.id.home_wifi));
        assertNotNull(find(root,"权限准备"));
        assertFalse(a.findViewById(R.id.home_pause).isShown());
        assertFalse(a.findViewById(R.id.home_stop).isShown());
      });
      screen("android-home");
      scenario.onActivity(a -> {
        a.findViewById(R.id.home_usb).performClick();
        assertNotNull(find(sheet(a).getWindow().getDecorView(),"USB 调试"));
        sheet(a).findViewById(R.id.sheet_close).performClick();
        a.findViewById(R.id.home_wifi).performClick();
        assertNotNull(find(sheet(a).getWindow().getDecorView(),"Wi-Fi 无线调试"));
        assertFalse(pairing().contains("token"));
        assertNull(ControlService.current);
      });
      screen("android-wifi");
    }
  }

  @Test public void pairedComputerNeedsLiveEvidenceAndSettingsDoNotSwitchTransport() throws Exception {
    pairing().edit().putString("token",TEST_TOKEN).putString("computer","Test computer").commit();
    try (ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)) {
      until(() -> ControlService.current!=null);
      scenario.onActivity(a -> {
        assertNotEquals("电脑已连接",status(a));
        assertNull(ControlService.current.session.sessionId);
        ControlService.current.connection.heartbeat("usb");
      });
      awaitTitle(scenario,"电脑已连接");
      scenario.onActivity(a -> {
        a.findViewById(R.id.home_wifi).performClick();
        assertTrue(ControlService.current.connection.connected("usb"));
        assertFalse(ControlService.current.connection.connected("wifi"));
        assertNull(ControlService.current.session.sessionId);
        sheet(a).findViewById(R.id.sheet_close).performClick();
      });
      screen("android-connected");
      awaitTitle(scenario,"电脑连接中断");
      screen("android-disconnected");
      scenario.onActivity(a -> ControlService.current.connection.heartbeat("usb"));
      awaitTitle(scenario,"电脑已连接");
      scenario.onActivity(a -> { assertNull(ControlService.current.session.sessionId); assertFalse(a.findViewById(R.id.home_pause).isShown()); });
    }
  }

  @Test public void debuggingPairingConnectsWithoutApprovalAndOldTaskIntentsStayOnHome() throws Exception {
    Intent request=new Intent(context,MainActivity.class).putExtra("token",TEST_TOKEN).putExtra("computer","New computer");
    try (ActivityScenario<MainActivity> scenario=ActivityScenario.launch(request)) {
      until(() -> ControlService.current!=null);
      String instance=ControlService.current.session.instanceId;
      scenario.onActivity(a -> {
        assertEquals(TEST_TOKEN,pairing().getString("token","")); assertNull(sheet(a));
        assertNull(ControlService.current.session.sessionId);
        assertEquals("idle",ControlService.current.session.phase);
      });
      scenario.recreate();
      scenario.onActivity(a -> {
        assertNull(sheet(a)); assertEquals(instance,ControlService.current.session.instanceId);
        a.onNewIntent(new Intent(context,MainActivity.class).putExtra("token",TEST_TOKEN).putExtra("computer","New computer"));
        assertEquals(instance,ControlService.current.session.instanceId);
      });
      screen("android-auto-connected");
      scenario.onActivity(a -> {
        a.onNewIntent(new Intent(context,MainActivity.class).putExtra("taskId","old-task").putExtra("computerId","old-computer"));
        assertNotNull(a.findViewById(R.id.home_wifi)); assertNull(find(a.getWindow().getDecorView(),"任务"));
      });
    }
  }

  @Test public void publicLauncherCannotPairOrReplaceComputer() throws Exception {
    Intent launcher=context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
    assertNotNull(launcher);
    assertEquals("io.github.profilepilot.phone.LauncherActivity",launcher.getComponent().getClassName());
    launcher.putExtra("token",TEST_TOKEN).putExtra("computer","Untrusted app");
    try (ActivityScenario<MainActivity> scenario=ActivityScenario.launch(launcher)) {
      scenario.onActivity(a -> {
        assertFalse(pairing().contains("token")); assertNull(ControlService.current); assertNull(sheet(a));
        pairing().edit().putString("token","b".repeat(64)).putString("computer","Existing computer").commit();
        a.onNewIntent(new Intent(launcher).putExtra("token",TEST_TOKEN).putExtra("computer","Untrusted app"));
        assertEquals("b".repeat(64),pairing().getString("token",""));
        assertEquals("Existing computer",pairing().getString("computer",""));
      });
    }
  }

  @Test public void malformedConnectionDoesNotCreatePairing() {
    // Match the explicit desktop Intent when exercising onNewIntent. ActivityScenario
    // tracks lifecycle by Intent.filterEquals, including the original action/categories.
    try (ActivityScenario<MainActivity> scenario=ActivityScenario.launch(new Intent(context,MainActivity.class))) {
      scenario.onActivity(a -> {
        for (String token:new String[]{"", "bad-token", "a".repeat(65)})
          a.onNewIntent(new Intent(context,MainActivity.class).putExtra("token",token).putExtra("computer","Computer"));
        for (String computer:new String[]{"", " ", "a".repeat(121)})
          a.onNewIntent(new Intent(context,MainActivity.class).putExtra("token",TEST_TOKEN).putExtra("computer",computer));
        assertFalse(pairing().contains("token")); assertNull(ControlService.current); assertNull(sheet(a));
      });
    }
  }

  @Test public void reconnectNeverResumesOrReplacesAnUnfinishedSession() throws Exception {
    Intent request=new Intent(context,MainActivity.class).putExtra("token",TEST_TOKEN).putExtra("computer","Computer");
    try (ActivityScenario<MainActivity> scenario=ActivityScenario.launch(request)) {
      until(() -> ControlService.current!=null);
      scenario.onActivity(a -> {
        SessionState session=ControlService.current.session;
        session.start(session.instanceId,session.generation,java.util.UUID.randomUUID().toString(),"control","Computer","Test","Test",1);
        session.pause("User paused");
        long generation=session.generation;
        a.onNewIntent(new Intent(request));
        assertSame(session,ControlService.current.session);
        assertEquals("paused",session.phase); assertEquals(generation,session.generation);
        for (String phase:new String[]{"viewing","controlling","executing","paused","disconnected"}) {
          session.phase=phase;
          a.onNewIntent(new Intent(context,MainActivity.class).putExtra("token","b".repeat(64)).putExtra("computer","Other computer"));
          assertEquals(TEST_TOKEN,pairing().getString("token",""));
          assertSame(session,ControlService.current.session); assertEquals(phase,session.phase);
        }
        session.stop("Test finished");
      });
    }
  }

  @Test public void idleComputerCanBeReplacedWithoutApproval() throws Exception {
    Intent request=new Intent(context,MainActivity.class).putExtra("token",TEST_TOKEN).putExtra("computer","First computer");
    try (ActivityScenario<MainActivity> scenario=ActivityScenario.launch(request)) {
      until(() -> ControlService.current!=null);
      ControlService previous=ControlService.current;
      scenario.onActivity(a -> a.onNewIntent(new Intent(context,MainActivity.class)
          .putExtra("token","b".repeat(64)).putExtra("computer","Second computer")));
      until(() -> ControlService.current!=null && ControlService.current!=previous);
      scenario.onActivity(a -> {
        assertEquals("b".repeat(64),pairing().getString("token",""));
        assertEquals("Second computer",ControlService.current.session.computer);
        assertEquals("idle",ControlService.current.session.phase); assertNull(sheet(a));
      });
    }
  }

  @Test public void debuggingEntryRequiresSystemPermissionWhileLauncherRemainsPublic() throws Exception {
    var packages=context.getPackageManager();
    assertEquals("android.permission.DUMP",packages.getActivityInfo(new ComponentName(context,MainActivity.class),0).permission);
    assertEquals(android.content.pm.PackageManager.PERMISSION_GRANTED,
        packages.checkPermission("android.permission.DUMP","com.android.shell"));
    assertEquals(android.content.pm.PackageManager.PERMISSION_DENIED,
        packages.checkPermission("android.permission.DUMP",instrumentation.getContext().getPackageName()));
    Intent launcher=packages.getLaunchIntentForPackage(context.getPackageName());
    assertNotNull(launcher); assertNull(packages.getActivityInfo(launcher.getComponent(),0).permission);
  }
}
