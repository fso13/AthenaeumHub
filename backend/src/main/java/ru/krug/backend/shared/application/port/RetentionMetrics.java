package ru.krug.backend.shared.application.port;

/**
 * Minimal retention metrics seam. The default implementation keeps in-process counters and
 * emits one structured log line per non-empty batch; a Micrometer adapter can replace it
 * later without touching the application services.
 */
public interface RetentionMetrics {

    void deleted(String target, int count);

    long totalDeleted(String target);
}
