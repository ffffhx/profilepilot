package io.github.profilepilot.phone;

import org.json.JSONObject;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.concurrent.*;

/** ADB forwards to a loopback-only endpoint; no phone LAN listener is opened. */
final class PhoneServer implements Closeable {
    interface Handler { JSONObject handle(String method, JSONObject body) throws Exception; }
    private final ServerSocket server;
    private final ThreadPoolExecutor workers = new ThreadPoolExecutor(2, 4, 30, TimeUnit.SECONDS, new ArrayBlockingQueue<>(12));
    private final String token;
    private final Handler handler;
    PhoneServer(String token, Handler handler) throws IOException {
        this.token = token; this.handler = handler;
        server = new ServerSocket(); server.setReuseAddress(true); server.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), 18761));
        Thread accept = new Thread(() -> {
            while (!server.isClosed()) try {
                Socket socket = server.accept();
                try { workers.execute(() -> serve(socket)); } catch (RejectedExecutionException error) { socket.close(); }
            } catch (IOException error) { if (!server.isClosed()) android.util.Log.w("ProfilePilot", "Phone connection failed"); }
        }, "phone-control-accept"); accept.setDaemon(true); accept.start();
    }
    private void serve(Socket socket) {
        try (socket) {
            socket.setSoTimeout(7000); InputStream input = socket.getInputStream();
            String request = line(input); String authorization = ""; int length = -1, total = request.length();
            while (true) {
                String header = line(input); total += header.length(); if (total > 8192) throw new IOException("Headers too large"); if (header.isEmpty()) break;
                int colon = header.indexOf(':'); if (colon < 1) throw new IOException("Invalid header");
                String name = header.substring(0, colon).toLowerCase(Locale.ROOT), value = header.substring(colon + 1).trim();
                if (name.equals("authorization")) authorization = value;
                if (name.equals("content-length")) { if (length != -1) throw new IOException("Duplicate length"); length = Integer.parseInt(value); }
                if (name.equals("transfer-encoding")) throw new IOException("Chunked requests unsupported");
            }
            JSONObject response;
            if (!MessageDigest.isEqual(("Bearer " + token).getBytes(StandardCharsets.UTF_8), authorization.getBytes(StandardCharsets.UTF_8))) {
                response = new JSONObject().put("ok", false).put("code", "PAIRING_REQUIRED").put("error", "请在手机 App 中确认电脑配对");
            } else {
                if (!request.matches("POST /[a-z]+ HTTP/1\\.[01]") || length < 0 || length > 32768) throw new IOException("Invalid request");
                byte[] bytes = new byte[length]; int offset = 0;
                while (offset < length) { int count = input.read(bytes, offset, length - offset); if (count < 0) throw new IOException("Incomplete body"); offset += count; }
                try { response = handler.handle(request.split(" ")[1].substring(1), new JSONObject(new String(bytes, StandardCharsets.UTF_8))); }
                catch (Exception error) { response = new JSONObject().put("ok", false).put("code", "PHONE_ERROR").put("error", error.getMessage() == null ? "手机未完成请求" : error.getMessage()); }
            }
            byte[] bytes = response.toString().getBytes(StandardCharsets.UTF_8);
            OutputStream output = socket.getOutputStream(); output.write(("HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: " + bytes.length + "\r\n\r\n").getBytes(StandardCharsets.US_ASCII)); output.write(bytes); output.flush();
        } catch (Exception ignored) { /* no credential-bearing request logging */ }
    }
    private static String line(InputStream input) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        while (buffer.size() < 8192) { int value = input.read(); if (value < 0) throw new EOFException(); if (value == '\n') return new String(buffer.toByteArray(), StandardCharsets.US_ASCII).replace("\r", ""); buffer.write(value); }
        throw new IOException("Line too large");
    }
    @Override public void close() throws IOException { server.close(); workers.shutdownNow(); }
}
