package io.github.profilepilot.phone;

import static org.junit.Assert.*;
import android.content.Context;
import android.content.pm.PackageManager;
import android.content.ComponentName;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class BuildVariantTest {
  private final Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();

  @Test public void installedDebugComponentsUseSeparateIdentity() throws Exception {
    assertTrue(BuildConfig.DEBUG);
    assertEquals("io.github.profilepilot.phone.debug",context.getPackageName());
    assertTrue(BuildConfig.VERSION_NAME.endsWith("-dev"));
    assertEquals("ProfilePilot 开发版",context.getString(R.string.app_name));
    assertEquals(18763,BuildConfig.COMPANION_PORT);
    assertEquals("profilepilot-dev",BuildConfig.PAIRING_SCHEME);
    PackageManager packages=context.getPackageManager();
    assertNotNull(packages.getActivityInfo(new ComponentName(context,MainActivity.class),0));
    assertNotNull(packages.getServiceInfo(new ComponentName(context,PhoneAccessibility.class),0));
    assertEquals(context.getPackageName(),packages.resolveContentProvider(context.getPackageName()+".updates",0).packageName);
  }

  @Test public void developmentUpdaterUsesOnlyDevelopmentFeed() {
    assertEquals("https://github.com/ffffhx/profilepilot/releases/download/android-dev-latest/ProfilePilot-android-dev-update.json",
        UpdateRelease.MANIFEST_URL);
    assertFalse(UpdateRelease.MANIFEST_URL.contains("/android-latest/"));
  }
}
