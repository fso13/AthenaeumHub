package ru.krug.backend.plugin.infrastructure.config;

import org.springframework.stereotype.Component;

import ru.krug.backend.plugin.application.port.TranslationEnvPort;

/**
 * Environment fallback used until an administrator saves an explicit translation setting.
 * The value is never logged.
 */
@Component
public class TranslationEnvAdapter implements TranslationEnvPort {

    private final TranslationProperties properties;

    public TranslationEnvAdapter(TranslationProperties properties) {
        this.properties = properties;
    }

    @Override
    public String fallbackUrl() {
        return properties.url() == null ? "" : properties.url();
    }

    @Override
    public String fallbackProvider() {
        return properties.provider() == null ? "" : properties.provider();
    }
}
