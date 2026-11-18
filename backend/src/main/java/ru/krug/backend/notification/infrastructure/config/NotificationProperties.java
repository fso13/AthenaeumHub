package ru.krug.backend.notification.infrastructure.config;

import java.time.Duration;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

/**
 * E6 notification settings. Retention defaults to 90 days
 * (SYSTEM-ANALYSIS §6.3); the scheduler and the batch size are configurable per profile.
 */
@ConfigurationProperties(prefix = "krug.notifications")
public record NotificationProperties(
        @DefaultValue("true") boolean retentionEnabled,
        @DefaultValue("90") int retentionDays,
        @DefaultValue("500") int retentionBatchSize,
        @DefaultValue("10m") Duration retentionPollInterval) {

    public NotificationProperties {
        if (retentionDays < 1) {
            throw new IllegalArgumentException(
                    "krug.notifications.retention-days must be positive");
        }
        if (retentionBatchSize < 1) {
            throw new IllegalArgumentException(
                    "krug.notifications.retention-batch-size must be positive");
        }
        if (retentionPollInterval == null || retentionPollInterval.isZero()
                || retentionPollInterval.isNegative()) {
            throw new IllegalArgumentException(
                    "krug.notifications.retention-poll-interval must be positive");
        }
    }
}
