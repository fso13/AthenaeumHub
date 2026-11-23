package ru.krug.backend.shared.infrastructure.config;

import java.util.List;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.CorsConfigurationSource;
import org.springframework.web.cors.UrlBasedCorsConfigurationSource;

/**
 * #103: CORS for the browser API with credentials enabled.
 *
 * <p>The Auth BFF refresh cookie is {@code SameSite=Lax}; a split-origin deployment (for
 * example the Vite dev server on {@code :5173}) therefore needs
 * {@code Access-Control-Allow-Credentials: true} and a concrete allowed origin. Allowed
 * origins come from {@code krug.cors.allowed-origins}; an empty list keeps the API
 * same-origin only and fails closed for cross-origin browsers.</p>
 */
@Configuration
public class CorsConfig {

    @Bean
    public CorsConfiguration krugCorsConfiguration(CorsProperties properties) {
        CorsConfiguration config = new CorsConfiguration();
        // setAllowedOriginPatterns (not '*') is required for credentialed CORS.
        config.setAllowedOriginPatterns(properties.allowedOriginPatterns());
        config.setAllowedMethods(List.of("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"));
        config.setAllowedHeaders(List.of(
                "Accept",
                "Authorization",
                "Cache-Control",
                "Content-Type",
                "Idempotency-Key",
                "If-None-Match",
                "Origin",
                "X-Device-Id",
                "X-Request-Id",
                "X-Requested-With"));
        config.setExposedHeaders(List.of(
                "Idempotent-Replay",
                "Location",
                "Retry-After",
                "X-Request-Id"));
        config.setAllowCredentials(true);
        config.setMaxAge(3600L);
        return config;
    }

    @Bean
    public CorsConfigurationSource corsConfigurationSource(CorsConfiguration configuration) {
        UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
        source.registerCorsConfiguration("/api/**", configuration);
        return source;
    }
}
