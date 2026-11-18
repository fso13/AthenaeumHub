package ru.krug.backend.shared.infrastructure.config;

import java.time.Duration;

import org.springframework.stereotype.Component;

import ru.krug.backend.shared.application.port.RetentionSettings;

@Component
public class RetentionSettingsAdapter implements RetentionSettings {

    private final RetentionProperties properties;

    public RetentionSettingsAdapter(RetentionProperties properties) {
        this.properties = properties;
    }

    @Override
    public boolean enabled() {
        return properties.enabled();
    }

    @Override
    public Duration pollInterval() {
        return properties.pollInterval();
    }

    @Override
    public int batchSize() {
        return properties.batchSize();
    }

    @Override
    public Duration idempotencyInProgressTimeout() {
        return properties.idempotencyInProgressTimeout();
    }

    @Override
    public Duration outboxRetention() {
        return properties.outboxRetention();
    }

    @Override
    public Duration ticketRetention() {
        return properties.ticketRetention();
    }
}
