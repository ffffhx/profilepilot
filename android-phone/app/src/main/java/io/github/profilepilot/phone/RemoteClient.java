package io.github.profilepilot.phone;

import android.net.Uri;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.security.cert.*;
import java.util.*;
import javax.net.ssl.*;
import org.json.*;

final class RemoteClient {
  static final class ApiError extends IOException {
    final String code;

    ApiError(String code, String message) {
      super(message);
      this.code = code;
    }
  }

  static JSONObject object(Object... values) {
    JSONObject out = new JSONObject();
    try {
      for (int i = 0; i < values.length; i += 2) out.put((String) values[i], values[i + 1]);
    } catch (JSONException error) {
      throw new IllegalArgumentException(error);
    }
    return out;
  }

  static String endpoint(String text) throws Exception {
    URI value = new URI(text.trim());
    if (!"https".equals(value.getScheme())
        || value.getHost() == null
        || value.getRawUserInfo() != null
        || value.getRawQuery() != null
        || value.getRawFragment() != null
        || !(value.getPath().isEmpty() || value.getPath().equals("/"))
        || value.getPort() > 65535)
      throw new IllegalArgumentException("请输入完整 HTTPS 电脑地址，不能带路径、凭据或查询参数");
    return new URI("https", null, value.getHost(), value.getPort(), null, null, null).toString();
  }

  static JSONObject parsePair(String text) throws Exception {
    Uri uri = Uri.parse(text.trim());
    if (!"profilepilot".equals(uri.getScheme())
        || !"pair".equals(uri.getHost())
        || !"1".equals(uri.getQueryParameter("v")))
      throw new IllegalArgumentException("这不是 ProfilePilot 配对码");
    String id = uri.getQueryParameter("id"),
        fp = uri.getQueryParameter("fp"),
        token = uri.getQueryParameter("token"),
        name = uri.getQueryParameter("name");
    UUID.fromString(id);
    if (fp == null
        || !fp.matches("[a-f0-9]{64}")
        || token == null
        || !token.matches("[a-f0-9]{64}")
        || name == null
        || name.isEmpty()
        || name.length() > 120) throw new IllegalArgumentException("配对信息不完整");
    return object(
        "id",
        id,
        "name",
        name,
        "url",
        endpoint(uri.getQueryParameter("url")),
        "fingerprint",
        fp,
        "token",
        token);
  }

  static String fingerprint(X509Certificate cert) throws Exception {
    byte[] digest = MessageDigest.getInstance("SHA-256").digest(cert.getEncoded());
    StringBuilder out = new StringBuilder();
    for (byte b : digest) out.append(String.format(Locale.ROOT, "%02x", b & 255));
    return out.toString();
  }

  private static void verify(java.security.cert.Certificate cert, String expected)
      throws CertificateException {
    try {
      X509Certificate x = (X509Certificate) cert;
      x.checkValidity();
      if (!MessageDigest.isEqual(
          fingerprint(x).getBytes(StandardCharsets.US_ASCII),
          expected.getBytes(StandardCharsets.US_ASCII)))
        throw new CertificateException("电脑身份不匹配，请在电脑上重新配对");
    } catch (CertificateException error) {
      throw error;
    } catch (Exception error) {
      throw new CertificateException(error);
    }
  }

  static JSONObject post(JSONObject computer, String route, JSONObject body, boolean authenticated)
      throws Exception {
    String expected = computer.getString("fingerprint");
    if (!expected.matches("[a-f0-9]{64}")) throw new CertificateException("缺少可信电脑指纹");
    SSLContext tls = SSLContext.getInstance("TLS");
    tls.init(
        null,
        new TrustManager[] {
          new X509TrustManager() {
            public X509Certificate[] getAcceptedIssuers() {
              return new X509Certificate[0];
            }

            public void checkClientTrusted(X509Certificate[] chain, String auth)
                throws CertificateException {
              throw new CertificateException("不支持客户端认证");
            }

            public void checkServerTrusted(X509Certificate[] chain, String auth)
                throws CertificateException {
              if (chain == null || chain.length == 0) throw new CertificateException("缺少证书");
              verify(chain[0], expected);
            }
          }
        },
        null);
    HttpsURLConnection connection =
        (HttpsURLConnection) new URL(endpoint(computer.getString("url")) + route).openConnection();
    connection.setSSLSocketFactory(tls.getSocketFactory());
    // Pairing pins the computer identity rather than a changing LAN hostname.
    connection.setHostnameVerifier(
        (host, session) -> {
          try {
            verify(session.getPeerCertificates()[0], expected);
            return true;
          } catch (Exception error) {
            return false;
          }
        });
    connection.setInstanceFollowRedirects(false);
    connection.setConnectTimeout(7000);
    connection.setReadTimeout(20000);
    connection.setRequestMethod("POST");
    connection.setDoOutput(true);
    connection.setRequestProperty("Content-Type", "application/json");
    if (authenticated)
      connection.setRequestProperty("Authorization", "Bearer " + computer.getString("token"));
    byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
    connection.setFixedLengthStreamingMode(bytes.length);
    try {
      try (OutputStream out = connection.getOutputStream()) {
        out.write(bytes);
      }
      int status = connection.getResponseCode();
      if (status >= 300 && status < 400) throw new IOException("电脑地址重定向，请更新连接地址");
      InputStream source =
          status >= 400 ? connection.getErrorStream() : connection.getInputStream();
      if (source == null) throw new IOException("电脑没有返回结果");
      ByteArrayOutputStream out = new ByteArrayOutputStream();
      try (InputStream in = source) {
        byte[] buffer = new byte[8192];
        int count;
        while ((count = in.read(buffer)) != -1) {
          if (out.size() + count > 12 * 1024 * 1024) throw new IOException("响应过大，请在电脑查看");
          out.write(buffer, 0, count);
        }
      }
      JSONObject reply = new JSONObject(out.toString("UTF-8"));
      if (!reply.optBoolean("ok")) {
        JSONObject error = reply.optJSONObject("error");
        throw new ApiError(
            error == null ? "REQUEST_FAILED" : error.optString("code"),
            error == null ? "请求失败" : error.optString("message"));
      }
      return reply.getJSONObject("data");
    } finally {
      connection.disconnect();
    }
  }

  static JSONObject envelope(JSONObject command) {
    return object(
        "requestId",
        UUID.randomUUID().toString(),
        "issuedAt",
        System.currentTimeMillis(),
        "command",
        command);
  }

  static JSONObject read(JSONObject computer, JSONObject command) throws Exception {
    return post(computer, "/v1/request", envelope(command), true);
  }

  static JSONObject mutation(
      ComputerStore store, JSONObject computer, JSONObject command, boolean retry)
      throws Exception {
    String id = computer.getString("id");
    JSONObject body = store.pending(id);
    if (retry) {
      if (body == null) throw new IllegalStateException("没有待确认请求");
    } else {
      if (body != null) throw new IllegalStateException("上次操作尚未确认，请先重试或核对任务状态");
      body = envelope(command);
      store.pending(id, body);
    }
    try {
      JSONObject result = post(computer, "/v1/request", body, true);
      store.pending(id, null);
      return result;
    } catch (ApiError error) {
      if (!error.code.equals("MOBILE_REQUEST_UNCERTAIN")
          && !error.code.equals("MOBILE_REQUEST_EXPIRED")) store.pending(id, null);
      throw error;
    }
    // A transport error retains the exact envelope. Never silently replay with a new ID.
  }
}
