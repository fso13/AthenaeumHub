package ru.krug.backend.ops.infrastructure.config;

import org.springframework.stereotype.Component;

import ru.krug.backend.ops.application.port.DevSessionSettings;
import ru.krug.backend.shared.infrastructure.config.KrugProperties;

@Component
public class DevSessionSettingsAdapter implements DevSessionSettings {

    private final KrugProperties properties;

    public DevSessionSettingsAdapter(KrugProperties properties) {
        this.properties = properties;
    }

    @Override
    public String defaultDisplayName() {
        return properties.dev().defaultDisplayName();
    }

    @Override
    public String workspaceName() {
        return properties.dev().workspaceName();
    }

    @Override
    public String chatName() {
        return properties.dev().chatName();
    }
}
