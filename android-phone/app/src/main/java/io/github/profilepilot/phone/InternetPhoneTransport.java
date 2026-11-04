package io.github.profilepilot.phone;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;
import org.json.JSONObject;

final class InternetPhoneTransport {
  private static final class PinnedTls {
    final javax.net.ssl.SSLSocketFactory factory;
    final javax.net.ssl.HostnameVerifier verifier;
    PinnedTls(javax.net.ssl.SSLSocketFactory factory, String pin) {
      this.factory = factory;
      this.verifier = (host, session) -> {
        try { verify((X509Certificate) session.getPeerCertificates()[0], pin); return true; }
        catch (Exception error) { return false; }
      };
    }
  }
  private static final java.util.LinkedHashMap<String, PinnedTls> factories = new java.util.LinkedHashMap<>();
  private static void verify(X509Certificate certificate, String fingerprint) throws Exception {
    certificate.checkValidity();
    if (!MessageDigest.isEqual(RemoteClient.fingerprint(certificate).getBytes(StandardCharsets.US_ASCII), fingerprint.getBytes(StandardCharsets.US_ASCII)))
      throw new CertificateException("云端电脑身份已改变，请重新核对配对");
  }
  private static synchronized PinnedTls factory(String pin, boolean artifact) throws Exception {
    String key = pin + (artifact ? ":artifact" : ":control");
    PinnedTls cached = factories.get(key);
    if (cached != null) return cached;
    SSLContext tls = SSLContext.getInstance("TLS");
    tls.init(null, new TrustManager[] { new X509TrustManager() {
      public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
      public void checkClientTrusted(X509Certificate[] chain, String auth) throws CertificateException { throw new CertificateException("不支持客户端证书"); }
      public void checkServerTrusted(X509Certificate[] chain, String auth) throws CertificateException {
        try { if (chain == null || chain.length == 0) throw new CertificateException("缺少电脑证书"); verify(chain[0], pin); }
        catch (Exception error) { throw new CertificateException("云端电脑身份校验失败", error); }
      }
    } }, null);
    PinnedTls result = new PinnedTls(tls.getSocketFactory(), pin);
    factories.put(key, result);
    while (factories.size() > 8) factories.remove(factories.keySet().iterator().next());
    return result;
  }
  static HttpsURLConnection open(JSONObject link, String route, String token, JSONObject body, int timeout) throws Exception {
    String pin = link.getString("fingerprint");
    if (!pin.matches("[a-f0-9]{64}") || !token.matches("[a-f0-9]{64}")) throw new IllegalArgumentException("缺少可信配对信息");
    if (!route.matches("/v1/[a-z-]+")) throw new IllegalArgumentException("不支持的外网控制接口");
    HttpsURLConnection connection = (HttpsURLConnection) new URL(InternetPhoneProtocol.endpoint(link.getString("url")) + route).openConnection();
    // Reuse TLS sessions for this exact pinned identity. Rebuilding the context
    // for every heartbeat forces hundreds of handshakes during APK transfer.
    // File transfers must not borrow the command channel's pooled socket.
    PinnedTls identity = factory(pin, route.equals("/v1/artifact"));
    connection.setSSLSocketFactory(identity.factory);
    connection.setHostnameVerifier(identity.verifier);
    connection.setInstanceFollowRedirects(false); connection.setConnectTimeout(8000); connection.setReadTimeout(timeout);
    connection.setRequestMethod("POST"); connection.setDoOutput(true);
    connection.setRequestProperty("Authorization", "Bearer " + token);
    connection.setRequestProperty("Content-Type", "application/json");
    byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
    if (bytes.length > 4 * 1024 * 1024 + 4096) throw new IllegalArgumentException("外网控制响应过大");
    connection.setFixedLengthStreamingMode(bytes.length);
    try (java.io.OutputStream out = connection.getOutputStream()) { out.write(bytes); }
    catch (Exception error) { connection.disconnect(); throw error; }
    return connection;
  }
  static JSONObject read(HttpsURLConnection connection) throws Exception {
    int status = connection.getResponseCode();
    if (status != 200) throw new java.io.IOException(status == 401 ? "外网配对已失效，请重新配对" : "外网连接未获确认（" + status + "）");
    try (InputStream in = connection.getInputStream(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
      byte[] buffer = new byte[8192]; int count;
      while ((count = in.read(buffer)) != -1) {
        if (out.size() + count > 4 * 1024 * 1024 + 4096) throw new java.io.IOException("外网控制响应过大");
        out.write(buffer, 0, count);
      }
      JSONObject result = new JSONObject(out.toString("UTF-8"));
      if (!result.optBoolean("ok")) throw new java.io.IOException("外网控制请求未获确认");
      return result;
    }
  }
  static JSONObject request(JSONObject link, String route, String token, JSONObject body) throws Exception {
    HttpsURLConnection connection = open(link, route, token, body, 10000);
    // read closes a fully consumed body, returning the socket to Android's
    // connection pool. Explicit disconnect is reserved for failures/cancel.
    try { return read(connection); }
    catch (Exception error) { connection.disconnect(); throw error; }
  }
}
