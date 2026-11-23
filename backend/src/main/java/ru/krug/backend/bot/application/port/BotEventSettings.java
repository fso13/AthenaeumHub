package ru.krug.backend.bot.application.port;

import java.time.Duration;

/**
 * Application-facing bot-event configuration. The infrastructure properties record implements
 * it, so application services never depend on a Spring configuration type.
 */
public interface BotEventSettings {

    String responseUrl(String token);

    Duration connectTimeout();

    Duration requestTimeout();

    int maxPayloadBytes();

    int maxAttempts();

    Duration retryBaseDelay();

    Duration retryMaxDelay();

    boolean workerEnabled();

    Duration pollInterval();

    int batchSize();

    Duration responseTokenTtl();
}
