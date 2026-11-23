package ru.krug.backend.shared.infrastructure.config;

import java.util.Arrays;
import java.util.List;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

/**
 * #103: browser origins allowed to call the API with credentials.
 *
 * <p>The SPA is normally same-origin, but the dev Vite server ({@code :5173}) calls the
 * backend directly, and a split deployment is supported. Wildcards are rejected because
 * credentialed CORS must echo a concrete origin.</p>
 */
@ConfigurationProperties(prefix = "krug.cors")
public record CorsProperties(
        @DefaultValue("http://localhost:5173") String allowedOrigins) {

    public CorsProperties {
        if (allowedOrigins == null) {
            allowedOrigins = "";
        }
        if (parse(allowedOrigins).stream().anyMatch("*"::equals)) {
            throw new IllegalArgumentException("krug.cors.allowed-origins must not be '*'");
        }
    }

    /**
     * Concrete origin patterns. An empty list rejects every browser Origin, so production
     * must set {@code KRUG_CORS_ALLOWED_ORIGINS} (or the shared {@code KRUG_WS_ALLOWED_ORIGINS}).
     */
    public List<String> allowedOriginPatterns() {
        return parse(allowedOrigins);
    }

    private static List<String> parse(String value) {
        return Arrays.stream(value.split(","))
                .map(String::strip)
                .filter(origin -> !origin.isEmpty())
                .toList();
    }
}
