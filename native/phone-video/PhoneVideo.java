package io.github.profilepilot.video;

import android.graphics.Rect;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaFormat;
import android.os.IBinder;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Base64;
import android.view.Surface;
import org.json.JSONObject;
import java.nio.ByteBuffer;

/** Desktop-owned, read-only encoder under the already authorized debug transport.
 * ASCII framing survives Windows adb shell's CRLF conversion. stdin heartbeats
 * own its lifetime, including static screens, broken pipes and desktop crashes.
 * No APK installation, input injection, audio, files or MediaProjection consent.
 */
public final class PhoneVideo {
    private static volatile long heartbeat = SystemClock.elapsedRealtime();
    private static volatile boolean stopped;
    private static final int MAX_EDGE = 1280, FPS = 24, BITRATE = 1500000;
    private static Class<?> compositor;
    private static Object displayManager;

    private static int[] dimensions() throws Exception {
        Object info = displayManager.getClass().getMethod("getDisplayInfo", int.class).invoke(displayManager, 0);
        return new int[]{info.getClass().getField("logicalWidth").getInt(info), info.getClass().getField("logicalHeight").getInt(info),
            info.getClass().getField("rotation").getInt(info), info.getClass().getField("layerStack").getInt(info)};
    }
    private static void emit(JSONObject value) throws Exception {
        System.out.println("PPV1 " + value.toString());
        if (System.out.checkError()) throw new java.io.IOException("Preview reader disconnected");
    }
    private static String codec(byte[] csd) throws Exception {
        for (int i = 0; i + 7 < csd.length; i++) {
            if (csd[i] == 0 && csd[i+1] == 0) {
                int n = csd[i+2] == 1 ? i+3 : csd[i+2] == 0 && csd[i+3] == 1 ? i+4 : -1;
                if (n >= 0 && (csd[n] & 31) == 7 && n+3 < csd.length)
                    return String.format(java.util.Locale.ROOT, "avc1.%02x%02x%02x", csd[n+1]&255, csd[n+2]&255, csd[n+3]&255);
            }
        }
        throw new Exception("Invalid encoder configuration");
    }
    private static void capture(int[] size) throws Exception {
        float scale = Math.min(1f, (float)MAX_EDGE / Math.max(size[0], size[1]));
        int width = Math.max(16, (int)(size[0]*scale)/16*16), height = Math.max(16, (int)(size[1]*scale)/16*16);
        MediaCodec encoder = MediaCodec.createEncoderByType("video/avc");
        IBinder display = null; Surface surface = null; boolean running = false;
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
            display = (IBinder)compositor.getMethod("createDisplay", String.class, boolean.class).invoke(null, "ProfilePilot preview", false);
            compositor.getMethod("openTransaction").invoke(null);
            try {
                compositor.getMethod("setDisplaySurface", IBinder.class, Surface.class).invoke(null, display, surface);
                compositor.getMethod("setDisplayLayerStack", IBinder.class, int.class).invoke(null, display, size[3]);
                compositor.getMethod("setDisplayProjection", IBinder.class, int.class, Rect.class, Rect.class)
                    .invoke(null, display, 0, new Rect(0,0,size[0],size[1]), new Rect(0,0,width,height));
            } finally { compositor.getMethod("closeTransaction").invoke(null); }
            encoder.start(); running = true;
            emit(new JSONObject().put("type","ready").put("encoder",encoder.getName()).put("hardware",encoder.getCodecInfo().isHardwareAccelerated()));
            byte[] config = null; String avc = null; long inspected = 0;
            MediaCodec.BufferInfo packet = new MediaCodec.BufferInfo();
            while (!stopped) {
                if (SystemClock.elapsedRealtime()-inspected > 250) {
                    inspected = SystemClock.elapsedRealtime();
                    if (!java.util.Arrays.equals(size, dimensions())) return;
                }
                int index = encoder.dequeueOutputBuffer(packet, 100000);
                if (index < 0) continue;
                try {
                    ByteBuffer data = encoder.getOutputBuffer(index);
                    if (data == null || packet.size == 0) continue;
                    data.position(packet.offset); data.limit(packet.offset+packet.size);
                    byte[] bytes = new byte[packet.size]; data.get(bytes);
                    if ((packet.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) { config = bytes; avc = codec(bytes); continue; }
                    boolean key = (packet.flags & MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0;
                    if (config == null || avc == null) continue;
                    if (key) { byte[] combined = new byte[config.length+bytes.length]; System.arraycopy(config,0,combined,0,config.length); System.arraycopy(bytes,0,combined,config.length,bytes.length); bytes=combined; }
                    emit(new JSONObject().put("type","frame").put("codec",avc).put("key",key).put("timestamp",packet.presentationTimeUs)
                        .put("width",width).put("height",height).put("screenWidth",size[0]).put("screenHeight",size[1])
                        .put("data",Base64.encodeToString(bytes,Base64.NO_WRAP)));
                } finally { encoder.releaseOutputBuffer(index,false); }
            }
        } finally {
            if (display != null) compositor.getMethod("destroyDisplay",IBinder.class).invoke(null,display);
            if (running) encoder.stop(); encoder.release(); if (surface != null) surface.release();
        }
    }
    public static void main(String[] args) throws Exception {
        Looper.prepareMainLooper();
        Thread input = new Thread(() -> { try { while (System.in.read()!=-1) heartbeat=SystemClock.elapsedRealtime(); } catch(Exception ignored) {} finally { stopped=true; } });
        input.setDaemon(true); input.start();
        Thread watchdog = new Thread(() -> { while (!stopped && SystemClock.elapsedRealtime()-heartbeat<5000) SystemClock.sleep(200); System.exit(0); });
        watchdog.setDaemon(true); watchdog.start();
        try {
            compositor=Class.forName("android.view.SurfaceControl");
            displayManager=Class.forName("android.hardware.display.DisplayManagerGlobal").getMethod("getInstance").invoke(null);
            while(!stopped) capture(dimensions());
        } catch(Throwable error) {
            Throwable cause=error instanceof java.lang.reflect.InvocationTargetException ? error.getCause() : error;
            emit(new JSONObject().put("type","error").put("message",String.valueOf(cause)));
            System.exit(1);
        }
    }
}
