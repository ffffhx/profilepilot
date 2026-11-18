package io.github.profilepilot.video;

import android.content.Context;
import android.content.ContextWrapper;
import android.graphics.Rect;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaFormat;
import android.os.Build;
import android.os.IBinder;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Base64;
import android.view.Surface;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.lang.reflect.Method;
import java.nio.ByteBuffer;

/** Desktop-owned, read-only encoder under the already authorized debug transport.
 * ASCII framing survives Windows adb shell's CRLF conversion. stdin heartbeats
 * own its lifetime, including static screens, broken pipes and desktop crashes.
 * No APK installation, input injection, audio, files or MediaProjection consent.
 */
public final class PhoneVideo {
    private static volatile long heartbeat = SystemClock.elapsedRealtime();
    private static volatile boolean stopped;
    private static volatile boolean announcedReady;
    private static final int MAX_EDGE = 1280, FPS = 24, BITRATE = 1500000;
    private static final int MIRROR_FLAGS = DisplayManager.VIRTUAL_DISPLAY_FLAG_PUBLIC
        | DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR | (1 << 4);
    private static Object displayManager;
    private static Context cachedShellContext;
    private static Class<?> cachedDisplayControl;
    private static boolean displayControlChecked;

    private interface MirrorHandle extends AutoCloseable {
        @Override void close();
    }

    private static Context shellContext() throws Exception {
        if (cachedShellContext != null) return cachedShellContext;
        Class<?> thread = Class.forName("android.app.ActivityThread");
        Object activityThread = thread.getMethod("systemMain").invoke(null);
        Context system = (Context) thread.getMethod("getSystemContext").invoke(activityThread);
        Context shell = system.createPackageContext("com.android.shell", Context.CONTEXT_IGNORE_SECURITY);
        cachedShellContext = new ContextWrapper(shell) {
            @Override public Context getApplicationContext() { return this; }
            @Override public String getPackageName() { return "com.android.shell"; }
            @Override public String getOpPackageName() { return "com.android.shell"; }
        };
        return cachedShellContext;
    }

    private static Class<?> loadDisplayControl() {
        if (displayControlChecked) return cachedDisplayControl;
        displayControlChecked = true;
        try {
            Class<?> factory = Class.forName("com.android.internal.os.ClassLoaderFactory");
            Method create = factory.getDeclaredMethod("createClassLoader",
                String.class, String.class, String.class, ClassLoader.class, int.class, boolean.class, String.class);
            create.setAccessible(true);
            ClassLoader loader = (ClassLoader) create.invoke(
                null, "/system/framework/services.jar", null, null, ClassLoader.getSystemClassLoader(), 0, true, null);
            Class<?> control = loader.loadClass("com.android.server.display.DisplayControl");
            try {
                Method loadLib = Runtime.class.getDeclaredMethod("loadLibrary0", Class.class, String.class);
                loadLib.setAccessible(true);
                loadLib.invoke(Runtime.getRuntime(), control, "android_servers");
            } catch (Throwable ignored) {
                try { System.loadLibrary("android_servers"); } catch (Throwable ignoredToo) { }
            }
            cachedDisplayControl = control;
        } catch (Throwable ignored) {
            cachedDisplayControl = null;
        }
        return cachedDisplayControl;
    }

    private static MirrorHandle configureSurfaceControlDisplay(Class<?> sc, IBinder token, Surface surface,
            int screenWidth, int screenHeight, int layerStack, int width, int height, Runnable destroyer) throws Exception {
        sc.getMethod("openTransaction").invoke(null);
        try {
            sc.getMethod("setDisplaySurface", IBinder.class, Surface.class).invoke(null, token, surface);
            sc.getMethod("setDisplayLayerStack", IBinder.class, int.class).invoke(null, token, layerStack);
            sc.getMethod("setDisplayProjection", IBinder.class, int.class, Rect.class, Rect.class)
                .invoke(null, token, 0, new Rect(0, 0, screenWidth, screenHeight), new Rect(0, 0, width, height));
        } finally {
            try { sc.getMethod("closeTransaction").invoke(null); } catch (Throwable ignored) { }
        }
        return destroyer::run;
    }

    private static MirrorHandle createMirror(Surface surface, int[] size, int width, int height) throws Exception {
        Throwable lastError = null;
        // 1) Android 11-13 SurfaceControl.createDisplay(String, boolean) (or when still present via reflection)
        try {
            Class<?> sc = Class.forName("android.view.SurfaceControl");
            Method create = null;
            if (Build.VERSION.SDK_INT < 34) {
                create = sc.getMethod("createDisplay", String.class, boolean.class);
            } else {
                try { create = sc.getMethod("createDisplay", String.class, boolean.class); }
                catch (NoSuchMethodException ignored) { }
            }
            if (create != null) {
                boolean secure = Build.VERSION.SDK_INT < 30 || (Build.VERSION.SDK_INT == 30 && !"S".equals(Build.VERSION.CODENAME));
                IBinder token = (IBinder) create.invoke(null, "ProfilePilot preview", secure);
                if (token != null) {
                    Method destroy = sc.getMethod("destroyDisplay", IBinder.class);
                    try {
                        return configureSurfaceControlDisplay(sc, token, surface, size[0], size[1], size[3], width, height, () -> {
                            try { destroy.invoke(null, token); } catch (Throwable ignored) { }
                        });
                    } catch (Throwable setupError) {
                        try { destroy.invoke(null, token); } catch (Throwable ignored) { }
                        throw setupError;
                    }
                }
            }
        } catch (Throwable error) {
            lastError = error;
        }

        // 2) Android 14+ com.android.server.display.DisplayControl via services.jar + android_servers
        try {
            Class<?> control = loadDisplayControl();
            if (control != null) {
                Class<?> sc = Class.forName("android.view.SurfaceControl");
                Method create = null;
                Method destroy = null;
                for (String pair : new String[]{"createVirtualDisplay:destroyVirtualDisplay", "createDisplay:destroyDisplay"}) {
                    String[] names = pair.split(":");
                    try {
                        create = control.getMethod(names[0], String.class, boolean.class);
                        destroy = control.getMethod(names[1], IBinder.class);
                        break;
                    } catch (NoSuchMethodException ignored) { }
                }
                if (create != null && destroy != null) {
                    IBinder token = (IBinder) create.invoke(null, "ProfilePilot preview", false);
                    if (token != null) {
                        Method finalDestroy = destroy;
                        try {
                            return configureSurfaceControlDisplay(sc, token, surface, size[0], size[1], size[3], width, height, () -> {
                                try { finalDestroy.invoke(null, token); } catch (Throwable ignored) { }
                            });
                        } catch (Throwable setupError) {
                            try { finalDestroy.invoke(null, token); } catch (Throwable ignored) { }
                            throw setupError;
                        }
                    }
                }
            }
        } catch (Throwable error) {
            lastError = error;
        }

        // 3a) DisplayManager hidden static createVirtualDisplay(String, int, int, int, Surface) (scrcpy Android 14-16 path)
        try {
            Method createStatic = DisplayManager.class.getMethod(
                "createVirtualDisplay", String.class, int.class, int.class, int.class, Surface.class);
            VirtualDisplay vd = (VirtualDisplay) createStatic.invoke(null, "ProfilePilot", width, height, 0, surface);
            if (vd != null) {
                return () -> { try { vd.release(); } catch (Throwable ignored) { } };
            }
        } catch (Throwable error) {
            lastError = error;
        }

        // 3b) VirtualDisplayConfig.Builder + DisplayManagerGlobal.getInstance().createVirtualDisplay(...) across API 34-36 signatures
        int densityDpi = Math.max(120, size[4]);
        try {
            Class<?> configClass = Class.forName("android.hardware.display.VirtualDisplayConfig");
            Class<?> builderClass = Class.forName("android.hardware.display.VirtualDisplayConfig$Builder");
            Object builder = builderClass.getConstructor(String.class, int.class, int.class, int.class)
                .newInstance("ProfilePilot", width, height, densityDpi);
            builderClass.getMethod("setFlags", int.class).invoke(builder, MIRROR_FLAGS);
            builderClass.getMethod("setSurface", Surface.class).invoke(builder, surface);
            try { builderClass.getMethod("setDisplayIdToMirror", int.class).invoke(builder, 0); }
            catch (NoSuchMethodException ignored) { }
            Object config = builderClass.getMethod("build").invoke(builder);
            Context ctx = null;
            try { ctx = shellContext(); } catch (Throwable ignored) { }
            for (Method candidate : displayManager.getClass().getMethods()) {
                if (!candidate.getName().equals("createVirtualDisplay")) continue;
                Class<?>[] params = candidate.getParameterTypes();
                boolean hasConfig = false;
                Object[] invokeArgs = new Object[params.length];
                for (int i = 0; i < params.length; i++) {
                    if (params[i].isAssignableFrom(configClass)) { invokeArgs[i] = config; hasConfig = true; }
                    else if (Context.class.isAssignableFrom(params[i])) { invokeArgs[i] = ctx; }
                    else if (params[i] == String.class) { invokeArgs[i] = "com.android.shell"; }
                    else { invokeArgs[i] = null; }
                }
                if (!hasConfig) continue;
                try {
                    VirtualDisplay vd = (VirtualDisplay) candidate.invoke(displayManager, invokeArgs);
                    if (vd != null) return () -> { try { vd.release(); } catch (Throwable ignored) { } };
                } catch (Throwable callError) {
                    lastError = callError;
                }
            }
        } catch (Throwable error) {
            lastError = error;
        }

        // 3c) Public DisplayManager.createVirtualDisplay fallback on shell Context
        try {
            DisplayManager dm = (DisplayManager) shellContext().getSystemService(Context.DISPLAY_SERVICE);
            if (dm != null) {
                VirtualDisplay vd = dm.createVirtualDisplay("ProfilePilot", width, height, densityDpi, surface, MIRROR_FLAGS);
                if (vd != null) return () -> { try { vd.release(); } catch (Throwable ignored) { } };
            }
        } catch (Throwable error) {
            lastError = error;
        }

        if (lastError instanceof Exception) throw (Exception) lastError;
        throw new RuntimeException("Unable to create mirror display", lastError);
    }

    private static int[] dimensions() throws Exception {
        Object info = displayManager.getClass().getMethod("getDisplayInfo", int.class).invoke(displayManager, 0);
        if (info == null) throw new IllegalStateException("Default display info is unavailable");
        Class<?> cls = info.getClass();
        int density = 320;
        try { density = cls.getField("logicalDensityDpi").getInt(info); } catch (NoSuchFieldException ignored) { }
        int w = cls.getField("logicalWidth").getInt(info);
        int h = cls.getField("logicalHeight").getInt(info);
        if (w <= 0 || h <= 0) throw new IllegalStateException("Invalid display bounds " + w + "x" + h);
        return new int[]{w, h, cls.getField("rotation").getInt(info), cls.getField("layerStack").getInt(info), density};
    }

    private static void emit(JSONObject value) throws Exception {
        System.out.println("PPV1 " + value.toString());
        if (System.out.checkError()) throw new java.io.IOException("Preview reader disconnected");
    }

    private static String codec(byte[] csd) throws Exception {
        for (int i = 0; i + 7 < csd.length; i++) {
            if (csd[i] == 0 && csd[i + 1] == 0) {
                int n = csd[i + 2] == 1 ? i + 3 : csd[i + 2] == 0 && csd[i + 3] == 1 ? i + 4 : -1;
                if (n >= 0 && (csd[n] & 31) == 7 && n + 3 < csd.length)
                    return String.format(java.util.Locale.ROOT, "avc1.%02x%02x%02x", csd[n + 1] & 255, csd[n + 2] & 255, csd[n + 3] & 255);
            }
        }
        throw new Exception("Invalid encoder configuration");
    }

    private static byte[] extractFormatCsd(MediaFormat outFormat) {
        if (outFormat == null) return null;
        ByteBuffer sps = outFormat.getByteBuffer("csd-0");
        ByteBuffer pps = outFormat.getByteBuffer("csd-1");
        if (sps == null) return null;
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        ByteBuffer spsCopy = sps.duplicate();
        byte[] spsBytes = new byte[spsCopy.remaining()];
        spsCopy.get(spsBytes);
        out.write(spsBytes, 0, spsBytes.length);
        if (pps != null) {
            ByteBuffer ppsCopy = pps.duplicate();
            byte[] ppsBytes = new byte[ppsCopy.remaining()];
            ppsCopy.get(ppsBytes);
            out.write(ppsBytes, 0, ppsBytes.length);
        }
        return out.size() > 0 ? out.toByteArray() : null;
    }

    private static void capture(int[] size) throws Exception {
        float scale = Math.min(1f, (float) MAX_EDGE / Math.max(size[0], size[1]));
        int width = Math.max(16, (int) (size[0] * scale) / 16 * 16);
        int height = Math.max(16, (int) (size[1] * scale) / 16 * 16);
        MediaCodec encoder = MediaCodec.createEncoderByType("video/avc");
        MirrorHandle mirror = null;
        Surface surface = null;
        boolean running = false;
        try {
            MediaFormat format = MediaFormat.createVideoFormat("video/avc", width, height);
            format.setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
            format.setInteger(MediaFormat.KEY_BIT_RATE, BITRATE);
            format.setInteger(MediaFormat.KEY_FRAME_RATE, FPS);
            format.setFloat("max-fps-to-encoder", FPS);
            format.setLong(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER, 100000L);
            format.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 2);
            encoder.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
            surface = encoder.createInputSurface();
            mirror = createMirror(surface, size, width, height);
            encoder.start();
            running = true;
            if (!announcedReady) {
                announcedReady = true;
                emit(new JSONObject().put("type", "ready").put("encoder", encoder.getName())
                    .put("hardware", encoder.getCodecInfo().isHardwareAccelerated()));
            }
            byte[] config = null;
            String avc = null;
            long inspected = 0;
            MediaCodec.BufferInfo packet = new MediaCodec.BufferInfo();
            while (!stopped) {
                if (SystemClock.elapsedRealtime() - inspected > 250) {
                    inspected = SystemClock.elapsedRealtime();
                    try {
                        if (!java.util.Arrays.equals(size, dimensions())) return;
                    } catch (Exception ignoredTransition) {
                        // Display metrics can briefly transition mid-rotation; check on next tick.
                    }
                }
                int index = encoder.dequeueOutputBuffer(packet, 100000);
                if (index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    byte[] formatCsd = extractFormatCsd(encoder.getOutputFormat());
                    if (formatCsd != null) { config = formatCsd; avc = codec(formatCsd); }
                    continue;
                }
                if (index < 0) continue;
                try {
                    ByteBuffer data = encoder.getOutputBuffer(index);
                    if (data == null || packet.size == 0) continue;
                    data.position(packet.offset);
                    data.limit(packet.offset + packet.size);
                    byte[] bytes = new byte[packet.size];
                    data.get(bytes);
                    if ((packet.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) {
                        config = bytes;
                        avc = codec(bytes);
                        continue;
                    }
                    if ((packet.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) return;
                    boolean key = (packet.flags & MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0;
                    if (config == null || avc == null) {
                        byte[] formatCsd = extractFormatCsd(encoder.getOutputFormat());
                        if (formatCsd != null) { config = formatCsd; avc = codec(formatCsd); }
                        if (config == null || avc == null) continue;
                    }
                    if (key) {
                        byte[] combined = new byte[config.length + bytes.length];
                        System.arraycopy(config, 0, combined, 0, config.length);
                        System.arraycopy(bytes, 0, combined, config.length, bytes.length);
                        bytes = combined;
                    }
                    emit(new JSONObject().put("type", "frame").put("codec", avc).put("key", key)
                        .put("timestamp", packet.presentationTimeUs)
                        .put("width", width).put("height", height)
                        .put("screenWidth", size[0]).put("screenHeight", size[1])
                        .put("data", Base64.encodeToString(bytes, Base64.NO_WRAP)));
                } finally {
                    try { encoder.releaseOutputBuffer(index, false); } catch (Throwable ignored) { }
                }
            }
        } finally {
            if (mirror != null) try { mirror.close(); } catch (Throwable ignored) { }
            if (running) try { encoder.stop(); } catch (Throwable ignored) { }
            try { encoder.release(); } catch (Throwable ignored) { }
            if (surface != null) try { surface.release(); } catch (Throwable ignored) { }
        }
    }

    public static void main(String[] args) throws Exception {
        Looper.prepareMainLooper();
        Thread input = new Thread(() -> {
            try { while (System.in.read() != -1) heartbeat = SystemClock.elapsedRealtime(); }
            catch (Exception ignored) { }
            finally { stopped = true; }
        });
        input.setDaemon(true);
        input.start();
        Thread watchdog = new Thread(() -> {
            while (!stopped && SystemClock.elapsedRealtime() - heartbeat < 5000) SystemClock.sleep(200);
            System.exit(0);
        });
        watchdog.setDaemon(true);
        watchdog.start();
        try {
            displayManager = Class.forName("android.hardware.display.DisplayManagerGlobal").getMethod("getInstance").invoke(null);
            int rotationFailures = 0;
            while (!stopped) {
                try {
                    int[] size = dimensions();
                    capture(size);
                    rotationFailures = 0;
                } catch (java.io.IOException disconnected) {
                    throw disconnected;
                } catch (Throwable transientError) {
                    if (stopped || !announcedReady || ++rotationFailures >= 5) throw transientError;
                    SystemClock.sleep(150);
                }
            }
        } catch (Throwable error) {
            Throwable cause = error instanceof java.lang.reflect.InvocationTargetException ? error.getCause() : error;
            emit(new JSONObject().put("type", "error").put("message", String.valueOf(cause)));
            System.exit(1);
        }
    }
}
