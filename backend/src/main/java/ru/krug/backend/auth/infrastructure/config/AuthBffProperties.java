package ru.krug.backend.auth.infrastructure.config;

import java.time.Duration;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Auth BFF settings ({@code krug.auth-bff}). Kept in infrastructure so application code
 * depends only on the {@link ru.krug.backend.auth.application.port.AuthBffSettings} port.
 *
 * <p>Secrets (Keycloak admin password, email-code key) are read from the environment and
 * are never logged.</p>
 */
@ConfigurationProperties(prefix = "krug.auth-bff")
public record AuthBffProperties(
        boolean registrationEnabled,
        boolean trustForwardedFor,
        Duration pendingSessionTtl,
        Keycloak keycloak,
        Mail mail,
        Code code,
        RateLimit rateLimit,
        Cleanup cleanup) {

    public record Keycloak(
            String baseUrl,
            String realm,
            String adminRealm,
            String adminUsername,
            String adminPassword,
            String adminClientId,
            String clientId,
            Duration connectTimeout,
            Duration readTimeout,
            Duration adminTokenSkew) {
    }

    public record Mail(String from) {
    }

    public record Code(
            Duration expiry,
            Duration resendCooldown,
            int maxAttempts,
            int window,
            String secretKey) {
    }

    public record RateLimit(
            boolean enabled,
            int registerPerEmail,
            Duration registerEmailWindow,
            int registerPerIp,
            Duration registerIpWindow,
            int loginPerEmail,
            Duration loginEmailWindow,
            int loginPerIp,
            Duration loginIpWindow,
            int resendPerEmail,
            Duration resendEmailWindow,
            int resendPerIp,
            Duration resendIpWindow) {
    }

    public record Cleanup(
            boolean enabled,
            Duration pollInterval,
            Duration initialDelay,
            int batchSize,
            Duration consumedRetention) {
    }
}
