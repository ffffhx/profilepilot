package io.github.profilepilot.camera;

import android.content.Context;
import android.content.ContextWrapper;
import android.content.Intent;
import android.content.ComponentName;
import android.content.pm.ResolveInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.util.Base64;
import android.view.Surface;
import android.opengl.EGL14;
import android.opengl.EGLConfig;
import android.opengl.EGLContext;
import android.opengl.EGLDisplay;
import android.opengl.EGLSurface;
import android.opengl.GLES20;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.*;
import java.lang.reflect.*;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;

/** Runs as the authorized Android debug transport's shell user, not inside the companion APK.
 * Only a live companion control lease can create a camera or accept frames and input.
 * System APIs stay behind reflection because they are absent from the public Android SDK.
 */
public final class ScreenCamera implements AutoCloseable {
    private static final int WIDTH = 720, HEIGHT = 1280, CAMERA_SIZE = 1024;
    private final Object frameLock = new Object();
    private final Map<Integer, Surface> surfaces = new ConcurrentHashMap<>();
    private final ExecutorService cameraExecutor = Executors.newSingleThreadExecutor();
    private final ScheduledExecutorService watchdog = Executors.newSingleThreadScheduledExecutor();
    private Context context;
    private Object virtualDevice, camera;
    private VirtualDisplay display;
    private ImageReader reader;
    private HandlerThread imageThread;
    private Bitmap frame;
    private byte[] preview;
    private JSONObject lease;
    private String associationAddress;
    private volatile boolean closed;
    private volatile long lastCommand = System.nanoTime();
    private volatile String failure;
    private volatile long framesReceived, framesRendered;
    private long lastPreview;

    private static Object call(Object target, String name, Class<?>[] types, Object... args) throws Exception {
        try { return target.getClass().getMethod(name, types).invoke(target, args); }
        catch (InvocationTargetException error) {
            Throwable cause = error.getCause();
            if (cause instanceof Exception) throw (Exception) cause;
            throw error;
        }
    }
    private static Object call(Object target, String name) throws Exception { return call(target, name, new Class<?>[0]); }
    private static Context shellContext() throws Exception {
        Class<?> thread = Class.forName("android.app.ActivityThread");
        Object activityThread = thread.getMethod("systemMain").invoke(null);
        Context system = (Context) thread.getMethod("getSystemContext").invoke(activityThread);
        Context shell = system.createPackageContext("com.android.shell", Context.CONTEXT_IGNORE_SECURITY);
        return new ContextWrapper(shell) {
            @Override public Context getApplicationContext() { return this; }
            @Override public String getPackageName() { return "com.android.shell"; }
            @Override public String getOpPackageName() { return "com.android.shell"; }
            @Override public android.content.AttributionSource getAttributionSource() {
                return new android.content.AttributionSource.Builder(android.os.Process.myUid()).setPackageName("com.android.shell").build();
            }
            @Override public Object getSystemService(String name) {
                Object service = super.getSystemService(name);
                if (service != null && (name.equals("companiondevice") || name.equals("virtualdevice"))) {
                    try {
                        Field field = service.getClass().getDeclaredField("mContext"); field.setAccessible(true); field.set(service, this);
                    } catch (ReflectiveOperationException error) { throw new IllegalStateException("Android service context is unavailable", error); }
                }
                return service;
            }
        };
    }
    private static String command(String... args) throws Exception {
        Process process = new ProcessBuilder(args).redirectErrorStream(true).start();
        if (!process.waitFor(8, TimeUnit.SECONDS)) { process.destroy(); throw new IOException("Android command timed out"); }
        String output = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8).trim();
        if (process.exitValue() != 0 || output.contains("Exception") || output.startsWith("Error:")) throw new IOException(output);
        return output;
    }
    private void authorize() throws Exception {
        if (closed) throw new IOException(failure == null ? "屏幕摄像头已停止" : failure);
        HttpURLConnection connection = (HttpURLConnection) new URL("http://127.0.0.1:18761/camera").openConnection();
        connection.setConnectTimeout(1200); connection.setReadTimeout(1200); connection.setRequestMethod("POST");
        connection.setDoOutput(true); connection.setRequestProperty("Authorization", "Bearer " + lease.getString("token"));
        connection.setRequestProperty("Content-Type", "application/json");
        try {
            JSONObject identity = new JSONObject().put("instanceId", lease.getString("instanceId"))
                .put("sessionId", lease.getString("sessionId")).put("generation", lease.getLong("generation"));
            connection.getOutputStream().write(identity.toString().getBytes(StandardCharsets.UTF_8));
            JSONObject result = new JSONObject(new String(connection.getInputStream().readAllBytes(), StandardCharsets.UTF_8));
            JSONObject state = result.getJSONObject("state");
            if (!result.optBoolean("ok") || !lease.getString("instanceId").equals(state.optString("instanceId"))
                || !lease.getString("sessionId").equals(state.optString("sessionId"))
                || lease.getLong("generation") != state.optLong("generation")
                || !"control".equals(state.optString("mode"))
                || !Arrays.asList("controlling", "executing").contains(state.optString("phase"))) {
                throw new IOException("手机控制已暂停、结束或改变，屏幕摄像头已停止");
            }
        } finally { connection.disconnect(); }
    }
    private JSONObject capabilities() throws Exception {
        boolean supported = Build.VERSION.SDK_INT >= 36;
        String reason = supported ? "" : "屏幕摄像头需要 Android 16 或更新版本";
        if (supported) try {
            Class.forName("android.companion.virtual.camera.VirtualCameraConfig");
            if (context.getSystemService("virtualdevice") == null) throw new UnsupportedOperationException();
        } catch (Exception error) { supported = false; reason = "此设备未提供 Android 虚拟摄像头服务"; }
        JSONObject graphics = supported ? cameraGraphics() : null;
        if (graphics != null && !graphics.getBoolean("supported")) {
            supported = false; reason = "此设备的图形驱动不支持屏幕摄像头：" + graphics.getString("reason");
        }
        return new JSONObject().put("sdk", Build.VERSION.SDK_INT).put("release", Build.VERSION.RELEASE)
            .put("supported", supported).put("reason", reason).put("graphics", graphics);
    }
    private static JSONObject cameraGraphics() throws Exception {
        EGLDisplay egl = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY);
        EGLContext context = EGL14.EGL_NO_CONTEXT; EGLSurface surface = EGL14.EGL_NO_SURFACE;
        JSONObject result = new JSONObject().put("supported", false).put("reason", "无法建立 OpenGL ES 3 环境");
        try {
            int[] version = new int[2];
            if (!EGL14.eglInitialize(egl, version, 0, version, 1)) return result;
            EGLConfig[] configs = new EGLConfig[1]; int[] count = new int[1];
            int[] attributes = { EGL14.EGL_SURFACE_TYPE, EGL14.EGL_PBUFFER_BIT, EGL14.EGL_RENDERABLE_TYPE, 0x40,
                EGL14.EGL_RED_SIZE, 8, EGL14.EGL_GREEN_SIZE, 8, EGL14.EGL_BLUE_SIZE, 8, EGL14.EGL_NONE };
            if (!EGL14.eglChooseConfig(egl, attributes, 0, configs, 0, 1, count, 0) || count[0] == 0) return result;
            context = EGL14.eglCreateContext(egl, configs[0], EGL14.EGL_NO_CONTEXT, new int[]{EGL14.EGL_CONTEXT_CLIENT_VERSION, 3, EGL14.EGL_NONE}, 0);
            surface = EGL14.eglCreatePbufferSurface(egl, configs[0], new int[]{EGL14.EGL_WIDTH, 1, EGL14.EGL_HEIGHT, 1, EGL14.EGL_NONE}, 0);
            if (!EGL14.eglMakeCurrent(egl, surface, surface, context)) return result;
            String extensions = GLES20.glGetString(GLES20.GL_EXTENSIONS);
            Set<String> available = new HashSet<>(Arrays.asList(extensions == null ? new String[0] : extensions.split(" ")));
            List<String> missing = new ArrayList<>();
            for (String required : new String[]{"GL_OES_EGL_image_external", "GL_OES_EGL_image_external_essl3", "GL_EXT_YUV_target"}) {
                if (!available.contains(required)) missing.add(required);
            }
            return result.put("supported", missing.isEmpty()).put("reason", missing.isEmpty() ? "" : "缺少 " + String.join(", ", missing))
                .put("renderer", GLES20.glGetString(GLES20.GL_RENDERER)).put("version", GLES20.glGetString(GLES20.GL_VERSION))
                .put("missingExtensions", new JSONArray(missing));
        } finally {
            EGL14.eglMakeCurrent(egl, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT);
            if (surface != EGL14.EGL_NO_SURFACE) EGL14.eglDestroySurface(egl, surface);
            if (context != EGL14.EGL_NO_CONTEXT) EGL14.eglDestroyContext(egl, context);
            EGL14.eglTerminate(egl);
        }
    }
    private void create() throws Exception {
        JSONObject supported = capabilities();
        if (!supported.getBoolean("supported")) throw new IOException(supported.getString("reason"));
        authorize();
        // Each session gets its own association. Never borrow or remove another app's association.
        byte[] address = new byte[5]; new java.security.SecureRandom().nextBytes(address);
        StringBuilder mac = new StringBuilder("02");
        for (byte part : address) mac.append(String.format(Locale.ROOT, ":%02x", part & 255));
        associationAddress = mac.toString();
        int userId = android.os.Process.myUid() / 100000;
        command("/system/bin/cmd", "companiondevice", "associate", Integer.toString(userId), "com.android.shell",
            associationAddress, "android.app.role.COMPANION_DEVICE_APP_STREAMING", "true");
        Object cdm = context.getSystemService("companiondevice");
        int associationId = -1;
        for (int attempt = 0; attempt < 30 && associationId < 0; attempt++) {
            for (Object info : (List<?>) call(cdm, "getMyAssociations")) {
                Object macAddress = call(info, "getDeviceMacAddress");
                if (macAddress != null && associationAddress.equalsIgnoreCase(macAddress.toString())) {
                    associationId = (Integer) call(info, "getId"); break;
                }
            }
            if (associationId < 0) Thread.sleep(100);
        }
        if (associationId < 0) throw new IOException("Android 未能建立屏幕摄像头的虚拟设备关联");
        Class<?> paramsClass = Class.forName("android.companion.virtual.VirtualDeviceParams");
        Object builder = Class.forName(paramsClass.getName() + "$Builder").getConstructor().newInstance();
        call(builder, "setName", new Class<?>[]{String.class}, "ProfilePilot Screen Camera");
        call(builder, "setDevicePolicy", new Class<?>[]{int.class, int.class}, 5, 1); // POLICY_TYPE_CAMERA, CUSTOM
        Object manager = context.getSystemService("virtualdevice");
        virtualDevice = call(manager, "createVirtualDevice", new Class<?>[]{int.class, paramsClass}, associationId, call(builder, "build"));

        imageThread = new HandlerThread("profilepilot-camera-preview"); imageThread.start();
        reader = ImageReader.newInstance(WIDTH, HEIGHT, PixelFormat.RGBA_8888, 3);
        reader.setOnImageAvailableListener(source -> {
            try (Image image = source.acquireLatestImage()) {
                if (image == null || closed) return;
                long now = System.nanoTime(); if (now - lastPreview < TimeUnit.MILLISECONDS.toNanos(250)) return; lastPreview = now;
                Image.Plane plane = image.getPlanes()[0];
                int paddedWidth = plane.getRowStride() / plane.getPixelStride();
                Bitmap padded = Bitmap.createBitmap(paddedWidth, HEIGHT, Bitmap.Config.ARGB_8888);
                padded.copyPixelsFromBuffer(plane.getBuffer());
                Bitmap bitmap = Bitmap.createBitmap(padded, 0, 0, WIDTH, HEIGHT);
                ByteArrayOutputStream bytes = new ByteArrayOutputStream(); bitmap.compress(Bitmap.CompressFormat.JPEG, 85, bytes);
                synchronized (frameLock) { preview = bytes.toByteArray(); }
                if (bitmap != padded) bitmap.recycle(); padded.recycle();
            } catch (Exception ignored) { /* A closed display can deliver one final buffer. */ }
        }, new Handler(imageThread.getLooper()));
        display = (VirtualDisplay) call(virtualDevice, "createVirtualDisplay",
            new Class<?>[]{int.class, int.class, int.class, Surface.class, int.class, Executor.class, VirtualDisplay.Callback.class},
            WIDTH, HEIGHT, 280, reader.getSurface(), (1 << 10) | (1 << 6) | (1 << 16), cameraExecutor, null);
        if (display == null) throw new IOException("Android 未能创建扫码应用窗口");

        Class<?> configClass = Class.forName("android.companion.virtual.camera.VirtualCameraConfig");
        Class<?> callbackClass = Class.forName("android.companion.virtual.camera.VirtualCameraCallback");
        Object callback = Proxy.newProxyInstance(callbackClass.getClassLoader(), new Class<?>[]{callbackClass}, (proxy, method, args) -> {
            if (method.getName().equals("onStreamConfigured")) surfaces.put((Integer) args[0], (Surface) args[1]);
            else if (method.getName().equals("onStreamClosed")) { Surface surface = surfaces.remove((Integer) args[0]); if (surface != null) surface.release(); }
            else if (method.getName().equals("onProcessCaptureRequest")) render((Integer) args[0]);
            else if (method.getName().equals("toString")) return "ProfilePilot VirtualCameraCallback";
            else if (method.getName().equals("hashCode")) return System.identityHashCode(proxy);
            else if (method.getName().equals("equals")) return proxy == args[0];
            return null;
        });
        Object config = Class.forName(configClass.getName() + "$Builder").getConstructor(String.class).newInstance("ProfilePilot Screen Camera");
        call(config, "addStreamConfig", new Class<?>[]{int.class, int.class, int.class, int.class}, CAMERA_SIZE, CAMERA_SIZE, PixelFormat.RGBA_8888, 30);
        call(config, "setLensFacing", new Class<?>[]{int.class}, 1); // CameraMetadata.LENS_FACING_BACK
        call(config, "setSensorOrientation", new Class<?>[]{int.class}, 0);
        call(config, "setVirtualCameraCallback", new Class<?>[]{Executor.class, callbackClass}, cameraExecutor, callback);
        camera = call(virtualDevice, "createVirtualCamera", new Class<?>[]{configClass}, call(config, "build"));
    }
    private void render(int streamId) {
        Surface surface = surfaces.get(streamId);
        if (surface == null || closed) return;
        Canvas canvas = null;
        try {
            canvas = surface.lockCanvas(null); canvas.drawColor(Color.WHITE);
            synchronized (frameLock) {
                if (frame != null && !closed) {
                    float scale = Math.min((float) canvas.getWidth() / frame.getWidth(), (float) canvas.getHeight() / frame.getHeight());
                    int w = Math.round(frame.getWidth() * scale), h = Math.round(frame.getHeight() * scale);
                    int x = (canvas.getWidth() - w) / 2, y = (canvas.getHeight() - h) / 2;
                    canvas.drawBitmap(frame, null, new Rect(x, y, x + w, y + h), new Paint(Paint.FILTER_BITMAP_FLAG));
                    framesRendered++;
                }
            }
        } catch (Exception error) { failure = "虚拟摄像头画面写入失败：" + error.getClass().getSimpleName(); }
        finally { if (canvas != null) try { surface.unlockCanvasAndPost(canvas); } catch (Exception ignored) { } }
    }
    private JSONObject status() throws Exception {
        return new JSONObject().put("displayId", display == null ? -1 : display.getDisplay().getDisplayId())
            .put("cameraId", camera == null ? "" : call(camera, "getId"))
            .put("width", WIDTH).put("height", HEIGHT).put("framesReceived", framesReceived)
            .put("framesRendered", framesRendered).put("streams", surfaces.size()).put("error", failure == null ? "" : failure);
    }
    private JSONObject handle(JSONObject input) throws Exception {
        lastCommand = System.nanoTime();
        String op = input.getString("op");
        if (op.equals("probe")) return capabilities();
        if (op.equals("start")) {
            if (lease != null) throw new IOException("屏幕摄像头已经启动");
            lease = input.getJSONObject("lease"); create();
            watchdog.scheduleWithFixedDelay(() -> {
                try {
                    if (System.nanoTime() - lastCommand > TimeUnit.SECONDS.toNanos(6)) throw new IOException("电脑画面连接已中断");
                    authorize();
                } catch (Exception error) { failure = error.getMessage(); close(); System.exit(0); }
            }, 0, 500, TimeUnit.MILLISECONDS);
            return status();
        }
        if (lease == null) throw new IOException("请先开始屏幕摄像头会话");
        authorize();
        switch (op) {
            case "pulse": return status();
            case "frame": {
                byte[] bytes = Base64.decode(input.getString("base64"), Base64.DEFAULT);
                if (bytes.length > 2 * 1024 * 1024) throw new IOException("画面超过大小限制");
                BitmapFactory.Options bounds = new BitmapFactory.Options(); bounds.inJustDecodeBounds = true;
                BitmapFactory.decodeByteArray(bytes, 0, bytes.length, bounds);
                if (bounds.outWidth < 1 || bounds.outHeight < 1 || bounds.outWidth > 4096 || bounds.outHeight > 4096) throw new IOException("画面尺寸无效");
                Bitmap next = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
                if (next == null) throw new IOException("画面格式无效");
                synchronized (frameLock) { Bitmap previous = frame; frame = next; framesReceived++; if (previous != null) previous.recycle(); }
                return status();
            }
            case "preview": {
                synchronized (frameLock) {
                    if (preview == null) throw new IOException("扫码应用窗口尚未产生画面");
                    return new JSONObject().put("mime", "image/jpeg").put("base64", Base64.encodeToString(preview, Base64.NO_WRAP)).put("width", WIDTH).put("height", HEIGHT);
                }
            }
            case "apps": {
                JSONArray apps = new JSONArray();
                Intent launcher = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
                for (ResolveInfo info : context.getPackageManager().queryIntentActivities(launcher, 0)) {
                    apps.put(new JSONObject().put("name", info.loadLabel(context.getPackageManager()))
                        .put("component", new ComponentName(info.activityInfo.packageName, info.activityInfo.name).flattenToString()));
                }
                return new JSONObject().put("apps", apps);
            }
            case "launch": {
                String component = input.getString("component");
                if (!component.matches("[a-zA-Z0-9_.$]+/[a-zA-Z0-9_.$]+")) throw new IOException("应用标识无效");
                command("/system/bin/am", "start", "--display", Integer.toString(display.getDisplay().getDisplayId()), "-n", component);
                return status();
            }
            case "tap": {
                int x = input.getInt("x"), y = input.getInt("y");
                if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) throw new IOException("点击坐标无效");
                command("/system/bin/input", "-d", Integer.toString(display.getDisplay().getDisplayId()), "tap", Integer.toString(x), Integer.toString(y));
                return status();
            }
            case "key": {
                String key = input.getString("key");
                if (!key.equals("back")) throw new IOException("只支持返回键");
                command("/system/bin/input", "-d", Integer.toString(display.getDisplay().getDisplayId()), "keyevent", "4");
                return status();
            }
            default: throw new IOException("未知屏幕摄像头命令");
        }
    }
    @Override public synchronized void close() {
        if (closed) return; closed = true; watchdog.shutdownNow();
        try { if (camera != null) call(camera, "close"); } catch (Exception ignored) { }
        try { if (display != null) display.release(); } catch (Exception ignored) { }
        try { if (virtualDevice != null) call(virtualDevice, "close"); } catch (Exception ignored) { }
        if (reader != null) reader.close(); if (imageThread != null) imageThread.quitSafely();
        for (Surface surface : surfaces.values()) surface.release(); surfaces.clear(); cameraExecutor.shutdownNow();
        synchronized (frameLock) { if (frame != null) frame.recycle(); frame = null; preview = null; }
        if (associationAddress != null) try {
            command("/system/bin/cmd", "companiondevice", "disassociate", Integer.toString(android.os.Process.myUid() / 100000), "com.android.shell", associationAddress);
        } catch (Exception ignored) { }
    }
    public static void main(String[] args) throws Exception {
        Looper.prepareMainLooper();
        ScreenCamera server = new ScreenCamera(); server.context = shellContext();
        Runtime.getRuntime().addShutdownHook(new Thread(server::close));
        Thread worker = new Thread(() -> {
            try (DataInputStream input = new DataInputStream(System.in)) {
                PrintStream output = System.out;
                while (!server.closed) {
                    int length = input.readInt();
                    if (length < 2 || length > 3 * 1024 * 1024) throw new IOException("Invalid message size");
                    byte[] bytes = new byte[length]; input.readFully(bytes);
                    JSONObject request = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
                    JSONObject response = new JSONObject().put("id", request.getInt("id"));
                    try { response.put("ok", true).put("data", server.handle(request)); }
                    catch (Exception error) { response.put("ok", false).put("error", error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage()); }
                    output.println(response); output.flush();
                }
            } catch (Exception ignored) { /* EOF ends the scoped camera. No credential/frame logging. */ }
            finally { server.close(); System.exit(0); }
        }, "profilepilot-camera-protocol"); worker.start(); Looper.loop();
    }
}
