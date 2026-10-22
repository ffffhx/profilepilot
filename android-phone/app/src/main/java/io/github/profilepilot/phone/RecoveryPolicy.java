package io.github.profilepilot.phone;

/** Conservative, monotonic-clock policy. A process restart never implies permission to enable Wi-Fi debugging. */
final class RecoveryPolicy {
    static final long NETWORK_WINDOW_MS = 300_000;
    static final long SETTLE_MS = 5_000;
    static final long MISSING_SERVICE_MS = 20_000;
    private boolean wifiWasEnabled;
    private long networkLostAt = -1, networkReadyAt = -1, missingSince = -1;
    private int attempts;
    private long nextAttempt;

    void networkLost(long now) {
        if (wifiWasEnabled && networkLostAt < 0) {
            networkLostAt = now; attempts = 0; nextAttempt = now;
        }
        networkReadyAt = -1;
    }

    void observeWifi(long now, boolean connected, Boolean debugging) {
        if (networkLostAt >= 0 && now - networkLostAt > NETWORK_WINDOW_MS) cancelNetwork();
        if (!connected) networkReadyAt = -1;
        else if (networkReadyAt < 0) networkReadyAt = now;
        if (Boolean.TRUE.equals(debugging)) {
            wifiWasEnabled = true;
            // A delayed OFF event can follow onAvailable; require a stable network first.
            if (connected && networkReadyAt >= 0 && now - networkReadyAt >= SETTLE_MS) cancelNetwork();
        } else if (Boolean.FALSE.equals(debugging) && networkLostAt < 0) {
            // Off on a stable network, including manual OFF, disarms recovery.
            wifiWasEnabled = false;
        }
    }

    boolean recoverWifi(long now, boolean connected, Boolean debugging, boolean authorized) {
        return authorized && connected && Boolean.FALSE.equals(debugging) && networkLostAt >= 0
            && now - networkLostAt <= NETWORK_WINDOW_MS && networkReadyAt >= 0
            && now - networkReadyAt >= SETTLE_MS && attempts < 3 && now >= nextAttempt;
    }

    void wifiAttempt(long now) { attempts++; nextAttempt = now + (attempts == 1 ? 15_000 : 60_000); }
    boolean networkPending() { return networkLostAt >= 0; }
    void cancelNetwork() { networkLostAt = -1; attempts = 0; }

    boolean recoverAccessibility(long now, boolean enabled, boolean running, boolean authorized) {
        if (!enabled || running) { missingSince = -1; return false; }
        if (missingSince < 0) missingSince = now;
        return authorized && now - missingSince >= MISSING_SERVICE_MS;
    }
    void accessibilityAttempt(long now) { missingSince = now; }

    static boolean budgetAvailable(long now, long windowStart, int attempts) {
        // Wall clock rollback must not replenish a retry budget.
        return attempts < 3 || (now >= windowStart && now - windowStart >= 1_800_000);
    }
}
