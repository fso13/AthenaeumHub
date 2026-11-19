package ru.krug.backend.plugin.infrastructure.config;

import java.time.Duration;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

/**
 * Optional outbound translation provider. The URL is intentionally empty by default, so
 * the endpoint returns {@code 503 TRANSLATION_UNAVAILABLE} without making any network
 * call. There is no API key/secret in this slice.
 */
@ConfigurationProperties(prefix = "krug.plugins.translate")
public record TranslationProperties(
        String url,
        @DefaultValue("2s") Duration connectTimeout,
        @DefaultValue("5s") Duration requestTimeout,
        @DefaultValue("65536") int maxResponseBytes) {

    public TranslationProperties {
        connectTimeout = connectTimeout == null ? Duration.ofSeconds(2) : connectTimeout;
        requestTimeout = requestTimeout == null ? Duration.ofSeconds(5) : requestTimeout;
        maxResponseBytes = maxResponseBytes < 1024 ? 65536 : maxResponseBytes;
        url = url == null ? "" : url.strip();
    }
}
