package io.github.profilepilot.phone;

import static org.junit.Assert.*;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.HexFormat;
import org.json.JSONObject;
import org.junit.Test;

public class UpdateReleaseTest {
  private JSONObject manifest() throws Exception {
    return new JSONObject().put("schemaVersion",1).put("applicationId","io.github.profilepilot.phone")
        .put("versionCode",8).put("versionName","0.3.2").put("minSdk",30).put("notes","新增更新\n保留设置")
        .put("url","https://github.com/ffffhx/profilepilot/releases/download/latest/ProfilePilot-android.apk")
        .put("size",4).put("sha256","a".repeat(64));
  }
  @Test public void comparesAndroidCodesAndNeverOffersSameOrOlderVersion() throws Exception {
    UpdateRelease release=UpdateRelease.parse(manifest().toString());
    assertTrue(release.newerThan(7)); assertFalse(release.newerThan(8)); assertFalse(release.newerThan(9));
    assertEquals("新增更新\n保留设置",release.notes());
  }
  @Test public void developmentAcceptsItsOwnPackageAndAssetAndRejectsStableUpdates() throws Exception {
    String development="io.github.profilepilot.phone.debug";
    JSONObject json=manifest().put("applicationId",development)
        .put("url","https://github.com/ffffhx/profilepilot/releases/download/android-dev-1200000/ProfilePilot-android-dev.apk");
    assertTrue(UpdateRelease.parse(json.toString(),development).newerThan(7));
    assertThrows(Exception.class,() -> UpdateRelease.parse(json.toString(),"io.github.profilepilot.phone"));
    json.put("url","https://github.com/ffffhx/profilepilot/releases/download/android-latest/ProfilePilot-android.apk");
    assertThrows(Exception.class,() -> UpdateRelease.parse(json.toString(),development));
  }
  @Test public void rejectsWrongAppUntrustedUrlsMalformedNumbersAndUnboundedFiles() throws Exception {
    Object[][] bad={{"schemaVersion",2},{"applicationId","another.app"},{"versionCode",0},
        {"versionCode",8.5},{"versionCode","8"},{"size",UpdateRelease.MAX_APK_BYTES+1},{"size",0},
        {"sha256","abc"},{"minSdk",0},{"versionName",""},{"notes","x".repeat(16001)},
        {"url","http://github.com/ffffhx/profilepilot/releases/download/latest/ProfilePilot-android.apk"},
        {"url","https://github.com.attacker.test/ffffhx/profilepilot/releases/download/latest/ProfilePilot-android.apk"},
        {"url","https://github.com/someone/other/releases/download/latest/ProfilePilot-android.apk"},
        {"url","https://user@github.com/ffffhx/profilepilot/releases/download/latest/ProfilePilot-android.apk"}};
    for (Object[] row:bad) assertThrows(row[0]+"="+row[1],Exception.class,() -> UpdateRelease.parse(manifest().put((String)row[0],row[1]).toString()));
  }
  private UpdateRelease release(byte[] bytes) throws Exception {
    return UpdateRelease.parse(manifest().put("size",bytes.length)
        .put("sha256",HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes))).toString());
  }
  @Test public void verifiesDownloadAndRejectsTruncationCorruptionAndOverrun() throws Exception {
    byte[] bytes={0x50,0x4b,3,4,10,20}; UpdateRelease release=release(bytes);
    File file=File.createTempFile("phone-update-",".apk");
    try {
      long[] progress={0}; UpdateTransfer.copyVerified(new ByteArrayInputStream(bytes),file,release,n -> progress[0]=n);
      assertEquals(bytes.length,progress[0]); UpdateTransfer.verify(file,release);
      Files.write(file.toPath(),new byte[]{0,0,0,0,0,0}); assertThrows(Exception.class,() -> UpdateTransfer.verify(file,release));
      for (byte[] invalid:new byte[][]{new byte[]{0x50,0x4b,3,4},new byte[6],new byte[7]}) {
        assertThrows(Exception.class,() -> UpdateTransfer.copyVerified(new ByteArrayInputStream(invalid),file,release,n -> {}));
        assertFalse("Failed downloads must be removed",file.exists());
      }
    } finally { file.delete(); }
  }
  @Test public void cancellationRemovesPartialFile() throws Exception {
    byte[] bytes={0x50,0x4b,3,4}; File file=File.createTempFile("phone-cancel-",".apk");
    try {
      UpdateRelease release=release(bytes); Thread.currentThread().interrupt();
      assertThrows(java.io.InterruptedIOException.class,() -> UpdateTransfer.copyVerified(new ByteArrayInputStream(bytes),file,release,n -> {}));
      assertFalse(file.exists());
    } finally { Thread.interrupted(); file.delete(); }
  }
}
