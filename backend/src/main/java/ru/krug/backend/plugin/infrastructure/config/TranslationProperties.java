package ru.krug.backend.plugin.infrastructure.config;

import java.time.Duration;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.ConstructorBinding;
import org.springframework.boot.context.properties.bind.DefaultValue;

/**
 * Optional self-hosted translation provider. The URL is intentionally empty by default, so
 * the endpoint returns {@code 503 TRANSLATION_UNAVAILABLE} without making any network call.
 *
 * <p>{@code provider} selects the wire protocol: {@code auto} (a {@code /translate} path
 * means LibreTranslate, anything else the legacy custom contract), {@code libretranslate}
 * or {@code custom}. An unknown environment value falls back to {@code auto}. There is no
 * API key/secret in this slice.</p>
 */
@ConfigurationProperties(prefix = "krug.plugins.translate")
public record TranslationProperties(
        String url,
        @DefaultValue("2s") Duration connectTimeout,
        @DefaultValue("5s") Duration requestTimeout,
        @DefaultValue("65536") int maxResponseBytes,
        @DefaultValue("auto") String provider) {

    @ConstructorBinding
    public TranslationProperties {
        connectTimeout = connectTimeout == null ? Duration.ofSeconds(2) : connectTimeout;
        requestTimeout = requestTimeout == null ? Duration.ofSeconds(5) : requestTimeout;
        maxResponseBytes = maxResponseBytes < 1024 ? 65536 : maxResponseBytes;
        url = url == null ? "" : url.strip();
        provider = provider == null ? "auto" : provider.strip();
    }

    /** Convenience for callers that only set the URL/timeouts. */
    public TranslationProperties(String url, Duration connectTimeout, Duration requestTimeout,
                                 int maxResponseBytes) {
        this(url, connectTimeout, requestTimeout, maxResponseBytes, "auto");
    }
}
