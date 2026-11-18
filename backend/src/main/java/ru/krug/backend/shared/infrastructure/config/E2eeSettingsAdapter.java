package ru.krug.backend.shared.infrastructure.config;

import org.springframework.stereotype.Component;

import ru.krug.backend.shared.application.port.E2eeSettingsPort;

@Component
public class E2eeSettingsAdapter implements E2eeSettingsPort {

    private final KrugProperties properties;

    public E2eeSettingsAdapter(KrugProperties properties) {
        this.properties = properties;
    }

    @Override
    public boolean enabled() {
        return properties.e2ee() != null && properties.e2ee().enabled();
    }
}
