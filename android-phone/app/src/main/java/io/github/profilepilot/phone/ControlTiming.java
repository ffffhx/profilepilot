package io.github.profilepilot.phone;

import android.os.SystemClock;
import android.util.Log;

/** Development-only stage durations. Never records credentials, inputs, or screen data. */
final class ControlTiming {
    private final long began = SystemClock.elapsedRealtime();
    private final StringBuilder stages = new StringBuilder();
    private String operation;
    private boolean finished;

    synchronized void operation(String method, String op) {
        if (!BuildConfig.DEBUG) return;
        if (method.equals("sync")) operation = "sync";
        else if (method.equals("follow") && (op.equals("frame") || op.equals("touch") || op.equals("probe"))) operation = "follow-" + op;
    }
    synchronized void mark(String stage) {
        if (!BuildConfig.DEBUG || finished || stages.length() > 1200) return;
        stages.append(' ').append(stage).append('=').append(SystemClock.elapsedRealtime() - began);
    }
    synchronized void finish() {
        if (!BuildConfig.DEBUG || finished) return;
        mark("total"); finished = true;
        if (operation != null) Log.d("ProfilePilotTiming", operation + stages);
    }
}
