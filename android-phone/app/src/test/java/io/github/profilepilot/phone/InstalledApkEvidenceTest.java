package io.github.profilepilot.phone;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import static org.junit.Assert.*;

public class InstalledApkEvidenceTest {
  @Rule public TemporaryFolder temporary = new TemporaryFolder();
  private static final String ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
  @Test public void hashesActualBytesAndRejectsMissingOversizeAndExpiredReads() throws Exception {
    File apk = temporary.newFile("base.apk");
    Files.write(apk.toPath(), "abc".getBytes(StandardCharsets.UTF_8));
    InstalledApkEvidence.Digest digest = InstalledApkEvidence.read(apk);
    assertEquals(ABC, digest.sha256()); assertEquals(3, digest.bytes());
    assertThrows(IOException.class, () -> InstalledApkEvidence.read(apk, 2, Long.MAX_VALUE));
    assertThrows(IOException.class, () -> InstalledApkEvidence.read(apk, 3, System.nanoTime() - 1));
    assertThrows(IOException.class, () -> InstalledApkEvidence.read(new File(temporary.getRoot(), "missing.apk")));
  }
  @Test public void onlyNewExactMonolithicContentsReconcileAnInstallerFailure() {
    assertTrue(InstalledApkEvidence.confirmsUpdate(true, 100, 101, ABC, 3, ABC, 3, 0));
    assertTrue(InstalledApkEvidence.confirmsUpdate(true, 0, 101, ABC, 3, ABC, 3, 0));
    assertFalse(InstalledApkEvidence.confirmsUpdate(false, 100, 101, ABC, 3, ABC, 3, 0));
    assertFalse(InstalledApkEvidence.confirmsUpdate(true, -1, 101, ABC, 3, ABC, 3, 0));
    assertFalse(InstalledApkEvidence.confirmsUpdate(true, 100, 100, ABC, 3, ABC, 3, 0));
    assertFalse(InstalledApkEvidence.confirmsUpdate(true, 100, 99, ABC, 3, ABC, 3, 0));
    assertFalse(InstalledApkEvidence.confirmsUpdate(true, 100, 101, ABC, 3, "f".repeat(64), 3, 0));
    assertFalse(InstalledApkEvidence.confirmsUpdate(true, 100, 101, ABC, 3, ABC, 4, 0));
    assertFalse(InstalledApkEvidence.confirmsUpdate(true, 100, 101, ABC, 3, ABC, 3, 1));
  }
}
