package ru.krug.backend.realtime.application.service;

import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import org.springframework.stereotype.Component;

/**
 * Fixed-window per-session limiter for call signalling. Signaling is bursty (ICE trickle),
 * so the window is intentionally generous; its purpose is to bound fan-out amplification,
 * not to police normal call setup. State is in-process, like the E3 hub.
 */
@Component
public class CallSignalRateLimiter {

    private static final int SWEEP_THRESHOLD = 4096;

    private final Map<String, Window> windows = new ConcurrentHashMap<>();

    /**
     * @return {@code true} when the frame may be processed; a rejected frame consumes no
     *         quota so a retry after the window is accepted
     */
    public boolean tryAcquire(String sessionId, Instant now, int limit, Duration window) {
        Window current = windows.computeIfAbsent(sessionId, key -> new Window(now));
        synchronized (current) {
            if (!now.isBefore(current.start.plus(window))) {
                current.start = now;
                current.count = 0;
            }
            if (current.count >= limit) {
                return false;
            }
            current.count++;
        }
        if (windows.size() > SWEEP_THRESHOLD) {
            windows.entrySet().removeIf(entry -> entry.getValue().expired(now, window));
        }
        return true;
    }

    /** Drops all state for a disconnected session; memory stays bounded by live sessions. */
    public void forget(String sessionId) {
        windows.remove(sessionId);
    }

    public int trackedSessions() {
        return windows.size();
    }

    private static final class Window {
        private Instant start;
        private int count;

        private Window(Instant start) {
            this.start = start;
        }

        private boolean expired(Instant now, Duration window) {
            return !now.isBefore(start.plus(window));
        }
    }
}
