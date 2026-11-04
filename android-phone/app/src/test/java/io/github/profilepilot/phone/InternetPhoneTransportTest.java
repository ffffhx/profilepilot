package io.github.profilepilot.phone;

import java.net.InetSocketAddress;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyStore;
import java.security.cert.X509Certificate;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class InternetPhoneTransportTest {
  private static String line(java.io.InputStream input) throws java.io.IOException {
    java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream();
    int value;
    while ((value = input.read()) != -1) {
      if (value == '\n') return bytes.toString("US-ASCII").replace("\r", "");
      if (bytes.size() >= 8192) throw new java.io.IOException("Test header too large");
      bytes.write(value);
    }
    return null;
  }
  private static void serve(javax.net.ssl.SSLSocket socket, Set<Integer> sockets, AtomicInteger accepted, AtomicInteger redirected) {
    try (socket) {
      socket.setSoTimeout(10000);
      java.io.InputStream input = new java.io.BufferedInputStream(socket.getInputStream());
      java.io.OutputStream out = socket.getOutputStream();
      String start;
      while ((start = line(input)) != null) {
        int length = 0; String header;
        while ((header = line(input)) != null && !header.isEmpty())
          if (header.toLowerCase(java.util.Locale.ROOT).startsWith("content-length:")) length = Integer.parseInt(header.substring(15).trim());
        if (length < 0 || length > 8192 || input.readNBytes(length).length != length) return;
        if (start.startsWith("POST /v1/poll ")) {
          redirected.incrementAndGet();
          out.write("HTTP/1.1 302 Found\r\nLocation: /v1/result\r\nContent-Length: 0\r\n\r\n".getBytes(java.nio.charset.StandardCharsets.US_ASCII));
        } else {
          accepted.incrementAndGet(); sockets.add(socket.getPort());
          out.write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{\"ok\":true}".getBytes(java.nio.charset.StandardCharsets.US_ASCII));
        }
        out.flush();
      }
    } catch (java.io.IOException ignored) { /* A mismatched certificate must close TLS before HTTP. */ }
  }
  @Test public void reusesPinnedConnectionsWithoutAcceptingAnotherIdentityOrRedirects() throws Exception {
    Path directory = Files.createTempDirectory("pp-internet-tls-");
    Path keys = directory.resolve("test.p12");
    javax.net.ssl.SSLServerSocket server = null;
    java.util.List<javax.net.ssl.SSLSocket> connections = new java.util.concurrent.CopyOnWriteArrayList<>();
    try {
      String executable = System.getProperty("os.name").startsWith("Windows") ? "keytool.exe" : "keytool";
      Process keytool = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", executable).toString(),
          "-genkeypair", "-alias", "test", "-keyalg", "RSA", "-keysize", "2048", "-validity", "2", "-dname", "CN=ProfilePilot test",
          "-storetype", "PKCS12", "-keystore", keys.toString(), "-storepass", "test-only", "-keypass", "test-only", "-noprompt")
          .redirectErrorStream(true).redirectOutput(directory.resolve("keytool.log").toFile()).start();
      assertTrue(keytool.waitFor(30, java.util.concurrent.TimeUnit.SECONDS));
      assertEquals(0, keytool.exitValue());
      KeyStore store = KeyStore.getInstance("PKCS12");
      try (java.io.InputStream input = Files.newInputStream(keys)) { store.load(input, "test-only".toCharArray()); }
      KeyManagerFactory managers = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
      managers.init(store, "test-only".toCharArray());
      SSLContext tls = SSLContext.getInstance("TLS"); tls.init(managers.getKeyManagers(), null, null);
      server = (javax.net.ssl.SSLServerSocket) tls.getServerSocketFactory().createServerSocket();
      server.bind(new InetSocketAddress("127.0.0.1", 0));
      Set<Integer> sockets = ConcurrentHashMap.newKeySet();
      AtomicInteger accepted = new AtomicInteger(), redirected = new AtomicInteger();
      javax.net.ssl.SSLServerSocket listener = server;
      Thread accept = new Thread(() -> {
        try { while (!listener.isClosed()) {
          javax.net.ssl.SSLSocket socket = (javax.net.ssl.SSLSocket) listener.accept(); connections.add(socket);
          Thread worker = new Thread(() -> serve(socket, sockets, accepted, redirected)); worker.setDaemon(true); worker.start();
        } } catch (java.io.IOException ignored) { }
      });
      accept.setDaemon(true); accept.start();
      JSONObject link = new JSONObject().put("url", "https://127.0.0.1:" + server.getLocalPort())
          .put("fingerprint", RemoteClient.fingerprint((X509Certificate) store.getCertificate("test")));
      for (int i = 0; i < 4; i++)
        assertTrue(InternetPhoneTransport.request(link, "/v1/result", "a".repeat(64), new JSONObject()).getBoolean("ok"));
      assertEquals("Fully read responses must return the TLS socket to the pool", 1, sockets.size());
      assertTrue(InternetPhoneTransport.request(link, "/v1/artifact", "a".repeat(64), new JSONObject()).getBoolean("ok"));
      assertEquals("Downloads use a separate pooled connection", 2, sockets.size());
      assertTrue(InternetPhoneTransport.request(link, "/v1/result", "a".repeat(64), new JSONObject()).getBoolean("ok"));
      assertEquals(2, sockets.size());
      JSONObject wrongIdentity = new JSONObject(link.toString()).put("fingerprint", "0".repeat(64));
      assertThrows(Exception.class, () -> InternetPhoneTransport.request(wrongIdentity, "/v1/result", "a".repeat(64), new JSONObject()));
      assertEquals("A differently pinned request cannot borrow the existing socket", 6, accepted.get());
      assertThrows(Exception.class, () -> InternetPhoneTransport.request(link, "/v1/poll", "a".repeat(64), new JSONObject()));
      assertEquals(1, redirected.get()); assertEquals(6, accepted.get());
    } finally {
      if (server != null) server.close();
      for (javax.net.ssl.SSLSocket socket : connections) socket.close();
      for (String name : new String[]{"test.p12", "keytool.log"}) Files.deleteIfExists(directory.resolve(name));
      Files.deleteIfExists(directory);
    }
  }
}
