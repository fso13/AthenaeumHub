package ru.krug.backend.shared.infrastructure.config;

import java.time.Duration;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

/**
 * B-02 retention/GC policy. The values are deliberately in one place because the same
 * stale-in-progress timeout is used by the idempotency reservation recovery path and by
 * the scheduled cleaner.
 */
@ConfigurationProperties(prefix = "krug.retention")
public record RetentionProperties(
        @DefaultValue("true") boolean enabled,
        @DefaultValue("10m") Duration pollInterval,
        @DefaultValue("500") int batchSize,
        @DefaultValue("1h") Duration idempotencyInProgressTimeout,
        @DefaultValue("7d") Duration outboxRetention,
        @DefaultValue("1d") Duration ticketRetention) {

    public RetentionProperties {
        if (pollInterval == null || pollInterval.isZero() || pollInterval.isNegative()) {
            throw new IllegalArgumentException("krug.retention.poll-interval must be positive");
        }
        if (batchSize < 1) {
            throw new IllegalArgumentException("krug.retention.batch-size must be positive");
        }
        if (idempotencyInProgressTimeout == null || idempotencyInProgressTimeout.isNegative()
                || idempotencyInProgressTimeout.isZero()) {
            throw new IllegalArgumentException(
                    "krug.retention.idempotency-in-progress-timeout must be positive");
        }
        if (outboxRetention == null || outboxRetention.isNegative() || outboxRetention.isZero()) {
            throw new IllegalArgumentException(
                    "krug.retention.outbox-retention must be positive");
        }
        if (ticketRetention == null || ticketRetention.isNegative() || ticketRetention.isZero()) {
            throw new IllegalArgumentException(
                    "krug.retention.ticket-retention must be positive");
        }
    }
}
