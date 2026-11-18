package ru.krug.backend.ops.infrastructure.config;

import org.springframework.stereotype.Component;

import ru.krug.backend.ops.application.port.OutboxRelaySettings;
import ru.krug.backend.shared.infrastructure.config.KrugProperties;

@Component
public class OutboxRelaySettingsAdapter implements OutboxRelaySettings {

    private final KrugProperties properties;

    public OutboxRelaySettingsAdapter(KrugProperties properties) {
        this.properties = properties;
    }

    @Override
    public int batchSize() {
        return properties.outbox().relay().batchSize();
    }
}
