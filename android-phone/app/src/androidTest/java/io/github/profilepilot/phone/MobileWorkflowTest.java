package io.github.profilepilot.phone;

import static org.junit.Assert.*;

import android.app.Dialog;
import android.app.Instrumentation;
import android.content.Context;
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

  @Test public void initialPairingRequiresApprovalAndOldTaskIntentsStayOnHome() throws Exception {
    Intent request=new Intent(context,MainActivity.class).putExtra("token",TEST_TOKEN).putExtra("computer","New computer");
    try (ActivityScenario<MainActivity> scenario=ActivityScenario.launch(request)) {
      scenario.onActivity(a -> { assertFalse(pairing().contains("token")); assertNotNull(sheet(a)); });
      scenario.recreate();
      scenario.onActivity(a -> {
        assertFalse(pairing().contains("token"));
        assertNotNull(find(sheet(a).getWindow().getDecorView(),"允许此电脑"));
      });
      screen("android-authorization");
      scenario.onActivity(a -> {
        find(sheet(a).getWindow().getDecorView(),"暂不允许").performClick();
        assertFalse(pairing().contains("token")); assertNull(ControlService.current);
        a.onNewIntent(new Intent(context,MainActivity.class).putExtra("taskId","old-task").putExtra("computerId","old-computer"));
        assertNotNull(a.findViewById(R.id.home_wifi)); assertNull(find(a.getWindow().getDecorView(),"任务"));
      });
    }
  }
}
