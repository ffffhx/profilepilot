package io.github.profilepilot.phone;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.SecureRandom;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;

final class InternetPhoneSettings {
  private static final String KEY_ALIAS = "profilepilot-internet-v1";
  private static final Object LOCK = new Object();

  private static SharedPreferences preferences(Context context) {
    return context.getSharedPreferences("InternetControl", Context.MODE_PRIVATE);
  }

  private static SecretKey secretKey() throws Exception {
    KeyStore store = KeyStore.getInstance("AndroidKeyStore");
    store.load(null);
    if (!store.containsAlias(KEY_ALIAS)) {
      KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
      generator.init(new KeyGenParameterSpec.Builder(
              KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
          .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
          .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
          .build());
      generator.generateKey();
    }
    return (SecretKey) store.getKey(KEY_ALIAS, null);
  }

  private static String encrypt(String plaintext) throws Exception {
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(Cipher.ENCRYPT_MODE, secretKey());
    return Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP)
        + ":"
        + Base64.encodeToString(cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP);
  }

  private static String decrypt(String encoded) throws Exception {
    String[] parts = encoded.split(":", 2);
    if (parts.length != 2) throw new IllegalArgumentException("Invalid encrypted payload");
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(Cipher.DECRYPT_MODE, secretKey(), new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
    return new String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), StandardCharsets.UTF_8);
  }

  private static JSONObject readEncryptedOrMigrate(SharedPreferences prefs, String key) {
    synchronized (LOCK) {
      String raw = prefs.getString(key, "");
      if (raw == null || raw.isEmpty()) return null;
      try {
        if (raw.trim().startsWith("{")) {
          // Transparently migrate legacy plaintext JSON to Android Keystore AES/GCM.
          JSONObject migrated = new JSONObject(raw);
          try {
            prefs.edit().putString(key, encrypt(migrated.toString())).commit();
          } catch (Exception ignoredKeystoreInUnitEnv) {
            // Retain readable state if KeyStore is unavailable outside Android hardware/emulator.
          }
          return migrated;
        }
        return new JSONObject(decrypt(raw));
      } catch (Exception error) {
        return null;
      }
    }
  }

  private static boolean writeEncrypted(SharedPreferences prefs, String key, JSONObject value) throws Exception {
    synchronized (LOCK) {
      String encoded = encrypt(value.toString());
      return prefs.edit().putString(key, encoded).commit();
    }
  }

  static JSONObject link(Context context) {
    return readEncryptedOrMigrate(preferences(context), "link");
  }

  static boolean enabled(Context context) {
    return preferences(context).getBoolean("enabled", false) && link(context) != null;
  }

  static void enabled(Context context, boolean value) {
    preferences(context).edit().putBoolean("enabled", value).apply();
  }

  static void forget(Context context) {
    synchronized (LOCK) {
      preferences(context).edit().remove("link").remove("pending").putBoolean("enabled", false).apply();
    }
  }

  static String name(Context context) {
    JSONObject value = link(context);
    return value == null ? "未配对云端电脑" : value.optString("computer", "云端电脑");
  }

  static synchronized void pair(Context context, JSONObject target) throws Exception {
    ControlService service = ControlService.current;
    // An explicitly confirmed pairing may be prepared by the current local
    // controller. It grants no session to the cloud and never resumes a pause.
    if (service != null && !service.canPairInternet()) throw new IllegalStateException("请先结束当前手机控制会话，再配对云端电脑");
    JSONObject old = link(context);
    if (old != null) throw new IllegalStateException("已有外网控制连接，请先在手机移除后重新配对");
    SharedPreferences prefs = preferences(context);
    JSONObject pending = readEncryptedOrMigrate(prefs, "pending");
    if (pending == null || !pending.optString("pairToken").equals(target.getString("pairToken"))
        || !pending.optString("serverId").equals(target.getString("serverId"))
        || !pending.optString("fingerprint").equals(target.getString("fingerprint")) || !pending.optString("url").equals(target.getString("url"))) {
      byte[] bytes = new byte[32]; new SecureRandom().nextBytes(bytes);
      StringBuilder token = new StringBuilder(); for (byte value : bytes) token.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
      pending = new JSONObject(target.toString()).put("token", token.toString()).put("deviceId", new ComputerStore(context).clientId());
      if (!writeEncrypted(prefs, "pending", pending)) throw new java.io.IOException("无法保存待确认的配对信息");
    }
    JSONObject response = InternetPhoneTransport.request(pending, "/v1/pair", pending.getString("pairToken"),
        new JSONObject().put("serverId", pending.getString("serverId")).put("deviceId", pending.getString("deviceId"))
          .put("token", pending.getString("token")).put("name", android.os.Build.MODEL));
    if (!pending.getString("serverId").equals(response.getString("serverId")) || !pending.getString("deviceId").equals(response.getString("deviceId")))
      throw new java.io.IOException("配对身份不一致");
    pending.remove("pairToken"); pending.put("computer", response.getString("computer"));
    synchronized (LOCK) {
      String encrypted = encrypt(pending.toString());
      if (!prefs.edit().putString("link", encrypted).remove("pending").putBoolean("enabled", true).commit())
        throw new java.io.IOException("无法保存云端电脑配对");
    }
  }
}
