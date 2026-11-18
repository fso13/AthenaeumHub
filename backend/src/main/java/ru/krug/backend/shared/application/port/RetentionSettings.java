package ru.krug.backend.shared.application.port;

import java.time.Duration;

/**
 * Retention policy read by the scheduled cleaners and by idempotency recovery. Kept as an
 * application port so the handlers stay independent of {@code application.yml} binding.
 */
public interface RetentionSettings {

    boolean enabled();

    Duration pollInterval();

    int batchSize();

    Duration idempotencyInProgressTimeout();

    Duration outboxRetention();

    Duration ticketRetention();
}
