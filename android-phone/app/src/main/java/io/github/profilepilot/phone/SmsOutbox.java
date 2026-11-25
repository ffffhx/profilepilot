package io.github.profilepilot.phone;

import android.Manifest;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import org.json.JSONArray;
import org.json.JSONObject;

/** Each grant and its encrypted queue belong to one pairing credential. */
final class SmsOutbox {
    private static final int LIMIT = 100;
    private static final long TTL = 48L * 60 * 60 * 1000;
    private final Context context;
    private final SharedPreferences prefs;
    private final ComputerStore store;

    SmsOutbox(Context context) {
        this.context = context.getApplicationContext();
        prefs = context.getSharedPreferences("sms-sync", Context.MODE_PRIVATE);
        store = new ComputerStore(context);
    }

    static String peer(String token) {
        if (token == null || !token.matches("[a-f0-9]{64}")) return "";
        try {
            return Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(
                token.getBytes(StandardCharsets.US_ASCII)), Base64.NO_WRAP | Base64.URL_SAFE);
        } catch (java.security.NoSuchAlgorithmException impossible) { throw new AssertionError(impossible); }
    }

    boolean permitted() {
        return context.checkSelfPermission(Manifest.permission.RECEIVE_SMS) == PackageManager.PERMISSION_GRANTED;
    }

    boolean granted(String route, String peer) {
        return !peer.isEmpty() && peer.equals(prefs.getString(route, ""));
    }

    void configure(String route, String peer) {
        synchronized (SmsOutbox.class) {
            if (!prefs.edit().putString(route, peer).remove("queue-" + route).commit())
                throw new IllegalStateException("短信同步设置保存失败");
        }
    }

    static JSONArray retained(JSONArray saved, String ack, long now) throws Exception {
        JSONArray retained = new JSONArray();
        long since = now - TTL;
        for (int i = 0; i < saved.length(); i++) {
            JSONObject item = saved.getJSONObject(i);
            if (item.getLong("receivedAt") >= since && !item.getString("messageId").equals(ack))
                retained.put(item);
        }
        return retained;
    }

    void enqueue(JSONObject sms) throws Exception {
        synchronized (SmsOutbox.class) {
            if (!permitted()) return;
            for (String route : new String[]{"adb", "internet"}) {
                if (prefs.getString(route, "").isEmpty()) continue;
                JSONArray queue = retained(store.readSmsQueue(prefs, route), "", System.currentTimeMillis());
                while (queue.length() >= LIMIT) queue.remove(0);
                queue.put(sms);
                store.writeSmsQueue(prefs, route, queue);
            }
        }
    }

    JSONObject next(String route, String peer, String ack) throws Exception {
        synchronized (SmsOutbox.class) {
            if (!granted(route, peer) || !permitted() || !prefs.contains("queue-" + route)) return null;
            JSONArray queue = retained(store.readSmsQueue(prefs, route), ack, System.currentTimeMillis());
            if (!ack.isEmpty() || queue.length() == 0) store.writeSmsQueue(prefs, route, queue);
            return queue.optJSONObject(0);
        }
    }
}
