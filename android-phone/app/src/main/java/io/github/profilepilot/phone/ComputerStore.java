package io.github.profilepilot.phone;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.UUID;
import javax.crypto.*;
import javax.crypto.spec.GCMParameterSpec;
import org.json.*;

/** Credentials and uncertain requests are encrypted with a non-exportable device key. */
final class ComputerStore {
  private static final Object LOCK = new Object();
  private final SharedPreferences prefs;

  ComputerStore(Context context) {
    prefs = context.getSharedPreferences("mobile-workspace", Context.MODE_PRIVATE);
  }

  private SecretKey key() throws Exception {
    KeyStore store = KeyStore.getInstance("AndroidKeyStore");
    store.load(null);
    if (!store.containsAlias("profilepilot-mobile-v1")) {
      KeyGenerator generator =
          KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
      generator.init(
          new KeyGenParameterSpec.Builder(
                  "profilepilot-mobile-v1",
                  KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
              .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
              .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
              .build());
      generator.generateKey();
    }
    return (SecretKey) store.getKey("profilepilot-mobile-v1", null);
  }

  private String decrypt(String value) throws Exception {
    if (value.isEmpty()) return "[]";
    String[] parts = value.split(":", 2);
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(
        Cipher.DECRYPT_MODE,
        key(),
        new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
    return new String(
        cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), StandardCharsets.UTF_8);
  }

  private String encrypt(String value) throws Exception {
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(Cipher.ENCRYPT_MODE, key());
    return Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP)
        + ":"
        + Base64.encodeToString(
            cipher.doFinal(value.getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP);
  }

  JSONArray all() throws Exception {
    synchronized (LOCK) {
      return new JSONArray(decrypt(prefs.getString("computers", "")));
    }
  }

  JSONObject find(String id) throws Exception {
    JSONArray all = all();
    for (int i = 0; i < all.length(); i++)
      if (all.getJSONObject(i).getString("id").equals(id)) return all.getJSONObject(i);
    return null;
  }

  void save(JSONObject computer) throws Exception {
    synchronized (LOCK) {
      JSONArray old = all(), next = new JSONArray();
      boolean found = false;
      for (int i = 0; i < old.length(); i++) {
        JSONObject item = old.getJSONObject(i);
        if (item.getString("id").equals(computer.getString("id"))) {
          next.put(computer);
          found = true;
        } else next.put(item);
      }
      if (!found) next.put(computer);
      if (!prefs.edit().putString("computers", encrypt(next.toString())).commit())
        throw new IllegalStateException("无法保存电脑凭据");
    }
  }

  void remove(String id) throws Exception {
    synchronized (LOCK) {
      JSONArray old = all(), next = new JSONArray();
      for (int i = 0; i < old.length(); i++)
        if (!old.getJSONObject(i).getString("id").equals(id)) next.put(old.getJSONObject(i));
      if (!prefs
          .edit()
          .putString("computers", encrypt(next.toString()))
          .remove("pending:" + id)
          .commit()) throw new IllegalStateException("无法移除电脑");
    }
  }

  String selected() {
    return prefs.getString("selected", "");
  }

  JSONObject statusLink(boolean pending) throws Exception {
    synchronized (LOCK) {
      String value = prefs.getString(pending ? "status-pending" : "status-link", "");
      return value.isEmpty() ? null : new JSONObject(decrypt(value));
    }
  }

  void statusLink(JSONObject value, boolean pending) throws Exception {
    synchronized (LOCK) {
      String name = pending ? "status-pending" : "status-link";
      SharedPreferences.Editor edit = prefs.edit();
      if (value == null) edit.remove(name); else edit.putString(name, encrypt(value.toString()));
      if (!edit.commit()) throw new IllegalStateException("无法保存状态同步配置");
    }
  }

  boolean statusEnabled() { return prefs.getBoolean("status-enabled", false); }
  void statusEnabled(boolean value) { prefs.edit().putBoolean("status-enabled", value).commit(); }

  void select(String id) {
    prefs.edit().putString("selected", id).apply();
  }

  String clientId() {
    synchronized (LOCK) {
      String id = prefs.getString("clientId", "");
      if (id.isEmpty()) {
        id = UUID.randomUUID().toString();
        prefs.edit().putString("clientId", id).commit();
      }
      return id;
    }
  }

  JSONObject pending(String id) throws Exception {
    synchronized (LOCK) {
      String value = prefs.getString("pending:" + id, "");
      return value.isEmpty() ? null : new JSONObject(decrypt(value));
    }
  }

  void pending(String id, JSONObject body) throws Exception {
    synchronized (LOCK) {
      SharedPreferences.Editor editor = prefs.edit();
      if (body == null) editor.remove("pending:" + id);
      else editor.putString("pending:" + id, encrypt(body.toString()));
      if (!editor.commit()) throw new IllegalStateException("无法保存请求状态");
    }
  }

  boolean notifications() {
    return prefs.getBoolean("notifications", false);
  }

  void notifications(boolean enabled) {
    prefs.edit().putBoolean("notifications", enabled).apply();
  }

  String draft(String id) {
    return prefs.getString("draft:" + id, "");
  }

  void draft(String id, String value) {
    prefs.edit().putString("draft:" + id, value).apply();
  }
}
