package io.github.profilepilot.phone;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.security.MessageDigest;
import java.util.Locale;

/** Bounded evidence from PackageManager's installed base APK, never a caller path. */
final class InstalledApkEvidence {
  static final long MAX_BYTES = 512L * 1024 * 1024;
  record Digest(String sha256, long bytes) { }

  static Digest read(File file) throws Exception {
    return read(file, MAX_BYTES, System.nanoTime() + 4_000_000_000L);
  }

  static Digest read(File file, long maxBytes, long deadlineNanos) throws Exception {
    long size = file.length(), modified = file.lastModified(), count = 0;
    if (!file.isFile() || size < 1 || size > maxBytes) throw new IOException("Installed APK is unavailable or exceeds the evidence limit");
    MessageDigest hash = MessageDigest.getInstance("SHA-256");
    try (FileInputStream in = new FileInputStream(file)) {
      byte[] buffer = new byte[256 * 1024];
      int read;
      while ((read = in.read(buffer)) != -1) {
        if (System.nanoTime() >= deadlineNanos || Thread.currentThread().isInterrupted()) throw new IOException("Installed APK verification timed out");
        count += read;
        if (count > size || count > maxBytes) throw new IOException("Installed APK changed during verification");
        hash.update(buffer, 0, read);
      }
    }
    if (count != size || file.length() != size || file.lastModified() != modified) throw new IOException("Installed APK changed during verification");
    StringBuilder hex = new StringBuilder();
    for (byte b : hash.digest()) hex.append(String.format(Locale.ROOT, "%02x", b & 255));
    return new Digest(hex.toString(), count);
  }

  static boolean confirmsUpdate(boolean submitted, long previousUpdateTime, long installedUpdateTime,
      String expectedHash, long expectedBytes, String actualHash, long actualBytes, int splitCount) {
    return submitted && previousUpdateTime >= 0 && installedUpdateTime > previousUpdateTime
        && splitCount == 0 && expectedBytes > 0 && expectedBytes == actualBytes
        && expectedHash != null && expectedHash.matches("[a-f0-9]{64}") && expectedHash.equals(actualHash);
  }
}
