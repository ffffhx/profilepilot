package io.github.profilepilot.phone;

import java.io.Closeable;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONObject;

/** An outbound connection only. Reconnect neither starts nor resumes a phone lease. */
final class InternetPhoneClient implements Closeable {
  interface Handler { JSONObject handle(String method, JSONObject body, ControlTiming timing, java.util.function.BooleanSupplier valid) throws Exception; }
  private final JSONObject link;
  private final Handler handler;
  private final Runnable lost;
  private volatile boolean closed;
  private volatile HttpsURLConnection current;
  private volatile String currentRoute = "";
  private final Thread worker;
  volatile String status = "正在连接云端电脑";
  volatile boolean connected;

  InternetPhoneClient(JSONObject source, Handler handler, Runnable lost) throws Exception {
    link = new JSONObject(source.toString()); this.handler = handler; this.lost = lost;
    worker = new Thread(this::run, "phone-internet-control"); worker.setDaemon(true); worker.start();
  }
  String serverId() { return link.optString("serverId"); }
  private JSONObject call(String route, JSONObject body, int timeout) throws Exception {
    if (closed) throw new java.io.IOException("外网连接已关闭");
    currentRoute = route;
    HttpsURLConnection connection = InternetPhoneTransport.open(link, route, link.getString("token"), body, timeout);
    current = connection;
    try { if (closed) throw new java.io.IOException("外网连接已关闭"); return InternetPhoneTransport.read(connection); }
    catch (Exception error) { connection.disconnect(); throw error; }
    finally { current = null; }
  }
  private void run() {
    int failures = 0;
    while (!closed) {
      String connectionId = UUID.randomUUID().toString();
      Map<String, JSONObject> receipts = new LinkedHashMap<>();
      Map<String, Long> seen = new LinkedHashMap<>();
      java.util.concurrent.atomic.AtomicBoolean live = new java.util.concurrent.atomic.AtomicBoolean(true);
      try {
        JSONObject identity = new JSONObject().put("deviceId", link.getString("deviceId")).put("connectionId", connectionId);
        call("/v1/connect", identity, 10000); connected = true; failures = 0; status = "外网控制已连接";
        while (!closed) {
          JSONObject packet = call("/v1/poll", identity, 25000);
          JSONObject command = packet.optJSONObject("command");
          if (command == null) continue;
          JSONObject result = receipts.get(command.optString("id"));
          if (result == null) {
            boolean validated = false;
            ControlTiming timing = new ControlTiming();
            try {
              InternetPhoneProtocol.validateCommand(command, connectionId, System.currentTimeMillis());
              if (closed) throw new IllegalStateException("外网连接已关闭");
              // Expired packets fail protocol validation above. Their IDs can
              // be retired without allowing a replay, keeping long-lived links
              // bounded without exhausting the cache after an hour of syncs.
              long now = System.currentTimeMillis();
              seen.values().removeIf(expiry -> expiry <= now);
              if (seen.size() >= 4096 || seen.containsKey(command.getString("id"))) throw new IllegalStateException("已处理过的请求不会再次执行");
              seen.put(command.getString("id"), command.getLong("expiresAt"));
              validated = true;
              long deadline = command.getLong("expiresAt");
              timing.operation(command.getString("method"), command.getJSONObject("body").optJSONObject("action") == null ? "" : command.getJSONObject("body").getJSONObject("action").optString("kind"));
              result = handler.handle(command.getString("method"), command.getJSONObject("body"), timing,
                  () -> !closed && live.get() && System.currentTimeMillis() < deadline);
            } catch (Exception error) {
              // Validation is known not sent; a handler timeout is uncertain and
              // must not turn into a second invocation after a network retry.
              boolean validation = !validated;
              result = new JSONObject().put("ok", false).put("code", validation ? "PHONE_INVALID_REQUEST" : "PHONE_EXECUTION_UNCERTAIN")
                  .put("error", validation ? "外网请求无效或已过期，未执行" : "手机尚未确认操作结果，请核对当前状态")
                  .put("actionOutcome", validation ? "not-executed" : "unknown");
            } finally { timing.finish(); }
            receipts.put(command.getString("id"), result);
            // At most two potentially large screenshots; a discarded receipt is
            // still in seen and can never execute a second time.
            while (receipts.size() > 2) receipts.remove(receipts.keySet().iterator().next());
          }
          call("/v1/result", new JSONObject(identity.toString()).put("requestId", command.getString("id")).put("result", result), 10000);
        }
      } catch (Exception error) {
        // No exception message/stack: a networking implementation may put the
        // private endpoint or credentials into its text.
        if (!closed) {
          StringBuilder frames = new StringBuilder();
          for (int i = 0; i < Math.min(5, error.getStackTrace().length); i++) {
            StackTraceElement frame = error.getStackTrace()[i];
            frames.append(" ").append(frame.getClassName()).append(".").append(frame.getMethodName());
          }
          android.util.Log.w("ProfilePilotInternet", "connection lost: " + currentRoute + " " + error.getClass().getSimpleName() + frames);
        }
        if (!closed) status = "外网连接中断，正在重新连接；控制会话不会自动恢复";
      } finally {
        live.set(false);
        boolean wasConnected = connected; connected = false;
        if (wasConnected) lost.run();
      }
      if (!closed) try { Thread.sleep(Math.min(10000, 1000L << Math.min(3, failures++))); }
      catch (InterruptedException ignored) { Thread.currentThread().interrupt(); return; }
    }
    status = "外网连接已关闭";
  }
  @Override public void close() {
    closed = true;
    HttpsURLConnection connection = current;
    if (connection != null) connection.disconnect();
    worker.interrupt();
  }
}
