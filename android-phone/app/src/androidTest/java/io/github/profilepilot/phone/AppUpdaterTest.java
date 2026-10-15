package io.github.profilepilot.phone;

import static org.junit.Assert.*;
import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.SystemClock;
import android.widget.Button;
import android.widget.TextView;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.IOException;
import java.lang.reflect.Field;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.LongConsumer;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Disposable emulator only. Uses the real installed APK and package/signature parser. */
@RunWith(AndroidJUnit4.class)
public class AppUpdaterTest {
  private final Instrumentation instrumentation=InstrumentationRegistry.getInstrumentation();
  private final Context context=instrumentation.getTargetContext();
  private final List<AppUpdater> updaters=new ArrayList<>();
  private byte[] apk;
  private JSONObject manifest;
  private AppUpdater original;
  private Field instance;
  private boolean leaveInstaller;

  @Before public void setup() throws Exception {
    assertTrue("Use a disposable emulator",Build.HARDWARE.contains("ranchu") || Build.HARDWARE.contains("goldfish"));
    apk=Files.readAllBytes(new File(context.getApplicationInfo().sourceDir).toPath());
    StringBuilder sha=new StringBuilder(); for (byte value:MessageDigest.getInstance("SHA-256").digest(apk)) sha.append(String.format(java.util.Locale.ROOT,"%02x",value & 255));
    manifest=new JSONObject().put("schemaVersion",1).put("applicationId",context.getPackageName())
        .put("versionCode",BuildConfig.VERSION_CODE).put("versionName",BuildConfig.VERSION_NAME).put("minSdk",30)
        .put("notes","更新测试").put("size",apk.length).put("sha256",sha.toString())
        .put("url","https://github.com/ffffhx/profilepilot/releases/download/android-dev-latest/ProfilePilot-android-dev.apk");
    instance=AppUpdater.class.getDeclaredField("instance"); instance.setAccessible(true);
    original=(AppUpdater)instance.get(null);
    clearDownloads();
  }
  @After public void cleanup() throws Exception {
    instrumentation.runOnMainSync(() -> {
      try { instance.set(null,original); } catch (Exception error) { throw new AssertionError(error); }
    });
    for (AppUpdater updater:updaters) {
      Field field=AppUpdater.class.getDeclaredField("worker"); field.setAccessible(true);
      ExecutorService worker=(ExecutorService)field.get(updater); worker.shutdownNow(); worker.awaitTermination(5,java.util.concurrent.TimeUnit.SECONDS);
    }
    if (!leaveInstaller) clearDownloads();
  }
  private void clearDownloads() {
    File[] files=new File(context.getFilesDir(),"updates").listFiles(); if (files!=null) for (File file:files) file.delete();
  }
  private class Fixture extends UpdateTransfer {
    String error;
    boolean slow;
    int downloads;
    @Override String manifest() throws IOException { if (error!=null) throw new IOException(error); return manifest.toString(); }
    @Override void download(UpdateRelease release,File file,LongConsumer progress) throws Exception {
      downloads++;
      if (slow) { progress.accept(1); Thread.sleep(10000); }
      copyVerified(new ByteArrayInputStream(apk),file,release,progress);
    }
  }
  private AppUpdater updater(Fixture fixture,long installed) {
    AppUpdater updater=new AppUpdater(context,fixture,installed); updaters.add(updater); return updater;
  }
  private void await(AppUpdater updater,AppUpdater.Stage stage) {
    long deadline=SystemClock.elapsedRealtime()+20000;
    AtomicReference<AppUpdater.State> state=new AtomicReference<>();
    while (SystemClock.elapsedRealtime()<deadline) {
      instrumentation.runOnMainSync(() -> state.set(updater.state()));
      if (state.get().stage()==stage) return;
      if (state.get().stage()==AppUpdater.Stage.ERROR && stage!=AppUpdater.Stage.ERROR) fail(state.get().message());
      SystemClock.sleep(50);
    }
    fail("Expected "+stage+", got "+state.get());
  }
  @Test public void checksDownloadsVerifiesAndReusesCompletedApkAfterRestart() throws Exception {
    Fixture fixture=new Fixture(); AppUpdater updater=updater(fixture,BuildConfig.VERSION_CODE-1);
    instrumentation.runOnMainSync(() -> { try { instance.set(null,updater); } catch (Exception error) { throw new AssertionError(error); } });
    instrumentation.runOnMainSync(updater::check); await(updater,AppUpdater.Stage.AVAILABLE);
    instrumentation.runOnMainSync(updater::download); await(updater,AppUpdater.Stage.READY);
    assertEquals(1,fixture.downloads);
    AppUpdater restarted=updater(fixture,BuildConfig.VERSION_CODE-1);
    instrumentation.runOnMainSync(restarted::check); await(restarted,AppUpdater.Stage.READY);
    assertEquals(1,fixture.downloads);
    AtomicReference<File> ready=new AtomicReference<>();
    instrumentation.runOnMainSync(() -> restarted.prepareInstall(ready::set)); await(restarted,AppUpdater.Stage.READY);
    assertNotNull(ready.get());
    try (ActivityScenario<UpdateActivity> scenario=ActivityScenario.launch(UpdateActivity.class)) {
      scenario.onActivity(activity -> {
        Intent intent=activity.installIntent(ready.get());
        assertEquals("content",intent.getData().getScheme());
        assertEquals("application/vnd.android.package-archive",intent.getType());
        assertNotEquals(0,intent.getFlags() & Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try (java.io.InputStream input=context.getContentResolver().openInputStream(intent.getData())) {
          assertEquals(0x50,input.read()); assertEquals(0x4b,input.read());
        } catch (Exception error) { throw new AssertionError(error); }
      });
    }
  }
  @Test public void currentOlderUnsupportedAndNetworkFailureNeverDownload() throws Exception {
    Fixture fixture=new Fixture(); AppUpdater current=updater(fixture,BuildConfig.VERSION_CODE);
    instrumentation.runOnMainSync(current::check); await(current,AppUpdater.Stage.CURRENT);
    AppUpdater newerInstalled=updater(fixture,BuildConfig.VERSION_CODE+1);
    instrumentation.runOnMainSync(newerInstalled::check); await(newerInstalled,AppUpdater.Stage.CURRENT);
    manifest.put("minSdk",Build.VERSION.SDK_INT+1);
    AppUpdater incompatible=updater(fixture,BuildConfig.VERSION_CODE-1);
    instrumentation.runOnMainSync(incompatible::check); await(incompatible,AppUpdater.Stage.INCOMPATIBLE);
    fixture.error="测试网络不可用";
    instrumentation.runOnMainSync(current::check); await(current,AppUpdater.Stage.ERROR);
    fixture.error=null; manifest.put("minSdk",30);
    instrumentation.runOnMainSync(current::check); await(current,AppUpdater.Stage.CURRENT);
    assertEquals(0,fixture.downloads);
  }
  @Test public void cancelThenRetryCannotBeOverwrittenByOldWorker() {
    Fixture fixture=new Fixture(); fixture.slow=true;
    AppUpdater updater=updater(fixture,BuildConfig.VERSION_CODE-1);
    instrumentation.runOnMainSync(updater::check); await(updater,AppUpdater.Stage.AVAILABLE);
    instrumentation.runOnMainSync(() -> { updater.download(); updater.cancel(); });
    await(updater,AppUpdater.Stage.AVAILABLE); fixture.slow=false;
    instrumentation.runOnMainSync(updater::download); await(updater,AppUpdater.Stage.READY);
  }
  @Test public void rejectsWrongVersionAndTamperingBeforeInstall() throws Exception {
    Fixture fixture=new Fixture(); manifest.put("versionCode",BuildConfig.VERSION_CODE+1);
    AppUpdater updater=updater(fixture,BuildConfig.VERSION_CODE-1);
    instrumentation.runOnMainSync(updater::check); await(updater,AppUpdater.Stage.AVAILABLE);
    instrumentation.runOnMainSync(updater::download); await(updater,AppUpdater.Stage.ERROR);
    manifest.put("versionCode",BuildConfig.VERSION_CODE);
    instrumentation.runOnMainSync(updater::check); await(updater,AppUpdater.Stage.AVAILABLE);
    instrumentation.runOnMainSync(updater::download); await(updater,AppUpdater.Stage.READY);
    Files.write(new File(context.getFilesDir(),"updates/"+manifest.getString("sha256")+".apk").toPath(),new byte[]{1,2,3,4});
    instrumentation.runOnMainSync(() -> updater.prepareInstall(file -> fail("Corrupted APK must not reach installer")));
    await(updater,AppUpdater.Stage.ERROR);
  }
  @Test public void updatePageSurvivesRecreationAndKeepsRetryVisible() throws Exception {
    Fixture fixture=new Fixture(); fixture.error="测试网络不可用";
    AppUpdater updater=updater(fixture,BuildConfig.VERSION_CODE);
    instrumentation.runOnMainSync(() -> { try { instance.set(null,updater); } catch (Exception error) { throw new AssertionError(error); } });
    try (ActivityScenario<UpdateActivity> scenario=ActivityScenario.launch(UpdateActivity.class)) {
      await(updater,AppUpdater.Stage.ERROR);
      scenario.recreate();
      scenario.onActivity(activity -> {
        assertEquals("测试网络不可用",((TextView)activity.findViewById(R.id.update_status)).getText().toString());
        Button action=activity.findViewById(R.id.update_action); assertTrue(action.isEnabled());
        fixture.error=null; action.performClick();
      });
      await(updater,AppUpdater.Stage.CURRENT);
      scenario.onActivity(activity -> assertEquals("当前已是最新版本",((TextView)activity.findViewById(R.id.update_status)).getText().toString()));
    }
  }

  /** Opt-in system handoff. The host runner confirms installation and checks retained data. */
  @Test public void handOffVerifiedApkToRealSystemInstaller() throws Exception {
    org.junit.Assume.assumeTrue("true".equals(InstrumentationRegistry.getArguments().getString("systemInstall")));
    Fixture fixture=new Fixture(); AppUpdater updater=updater(fixture,BuildConfig.VERSION_CODE-1);
    instrumentation.runOnMainSync(updater::check); await(updater,AppUpdater.Stage.AVAILABLE);
    instrumentation.runOnMainSync(updater::download); await(updater,AppUpdater.Stage.READY);
    assertTrue(context.getSharedPreferences("update-verification",Context.MODE_PRIVATE).edit().putString("retained","keep-after-update").commit());
    UpdateActivity activity=(UpdateActivity)instrumentation.startActivitySync(
        new Intent(context,UpdateActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
    instrumentation.runOnMainSync(() -> {
      File file=new File(context.getFilesDir(),"updates/"+updater.state().release().sha256()+".apk");
      activity.startActivity(activity.installIntent(file)); activity.finish();
    });
    leaveInstaller=true;
  }
}
