package ru.krug.backend.bot.infrastructure.config;

import java.time.Duration;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

import ru.krug.backend.bot.application.port.BotEventSettings;

/**
 * #98 bot event delivery tuning. Timeouts are deliberately short (5 s) because a webhook
 * receiver is not on the request path; retries use exponential backoff with a hard cap.
 */
@ConfigurationProperties(prefix = "krug.bots.events")
public record BotEventsProperties(
        @DefaultValue("http://localhost:8081/api/v1") String responseUrlBase,
        @DefaultValue("5s") Duration connectTimeout,
        @DefaultValue("5s") Duration requestTimeout,
        @DefaultValue("65536") int maxPayloadBytes,
        @DefaultValue("6") int maxAttempts,
        @DefaultValue("1s") Duration retryBaseDelay,
        @DefaultValue("1h") Duration retryMaxDelay,
        @DefaultValue("true") boolean workerEnabled,
        @DefaultValue("1s") Duration pollInterval,
        @DefaultValue("25") int batchSize,
        @DefaultValue("5m") Duration responseTokenTtl) implements BotEventSettings {

    public BotEventsProperties {
        responseUrlBase = responseUrlBase == null || responseUrlBase.isBlank()
                ? "http://localhost:8081/api/v1"
                : stripTrailingSlash(responseUrlBase.strip());
        connectTimeout = positive(connectTimeout, Duration.ofSeconds(5));
        requestTimeout = positive(requestTimeout, Duration.ofSeconds(5));
        maxPayloadBytes = maxPayloadBytes < 1024 ? 65536 : Math.min(maxPayloadBytes, 65536);
        maxAttempts = maxAttempts < 1 ? 6 : Math.min(maxAttempts, 20);
        retryBaseDelay = positive(retryBaseDelay, Duration.ofSeconds(1));
        retryMaxDelay = positive(retryMaxDelay, Duration.ofHours(1));
        if (retryMaxDelay.compareTo(retryBaseDelay) < 0) {
            retryMaxDelay = retryBaseDelay;
        }
        pollInterval = positive(pollInterval, Duration.ofSeconds(1));
        batchSize = batchSize < 1 ? 25 : Math.min(batchSize, 200);
        responseTokenTtl = positive(responseTokenTtl, Duration.ofMinutes(5));
    }

    public String responseUrl(String token) {
        return responseUrlBase + "/bot-responses/" + token;
    }

    private static Duration positive(Duration value, Duration fallback) {
        return value == null || value.isNegative() || value.isZero() ? fallback : value;
    }

    private static String stripTrailingSlash(String value) {
        int end = value.length();
        while (end > 0 && value.charAt(end - 1) == '/') {
            end--;
        }
        return value.substring(0, end);
    }
}
