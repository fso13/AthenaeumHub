package ru.krug.backend.auth.infrastructure.config;

import java.time.Duration;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

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
        TwoFactor twoFactor,
        RateLimit rateLimit,
        Cleanup cleanup,
        RefreshCookie refreshCookie) {

    public record Keycloak(
            String baseUrl,
            String realm,
            String adminRealm,
            String adminUsername,
            String adminPassword,
            String adminClientId,
            String clientId,
            // #103: client-credentials service account for the runtime Keycloak Admin API.
            // Blank in dev keeps the documented password-grant fallback; prod requires both.
            String serviceClientId,
            String serviceClientSecret,
            Duration connectTimeout,
            Duration readTimeout,
            Duration adminTokenSkew) {
    }

    /**
     * #103: the browser refresh token is an HttpOnly cookie. The path is narrowed to the
     * Auth BFF so the token is not attached to every API request; Secure is enabled by the
     * prod profile and stays off for plain-http localhost development.
     */
    public record RefreshCookie(
            @DefaultValue("sova_refresh") String name,
            @DefaultValue("/api/v1/auth") String path,
            @DefaultValue("false") boolean secure,
            @DefaultValue("Lax") String sameSite,
            @DefaultValue("30m") Duration maxAge) {

        public RefreshCookie {
            if (name == null || !name.matches("[A-Za-z0-9_-]{1,64}")) {
                throw new IllegalArgumentException(
                        "krug.auth-bff.refresh-cookie.name must be a safe cookie name");
            }
            if (path == null || !path.startsWith("/") || path.contains(";")
                    || path.contains("\r") || path.contains("\n")) {
                throw new IllegalArgumentException(
                        "krug.auth-bff.refresh-cookie.path must be an absolute cookie path");
            }
            String normalized = sameSite == null ? "" : sameSite.strip();
            if (!normalized.equals("Lax") && !normalized.equals("Strict")
                    && !normalized.equals("None")) {
                throw new IllegalArgumentException(
                        "krug.auth-bff.refresh-cookie.same-site must be Lax, Strict or None");
            }
            if (normalized.equals("None") && !secure) {
                throw new IllegalArgumentException(
                        "krug.auth-bff.refresh-cookie.same-site=None requires secure=true");
            }
            if (maxAge == null || maxAge.isZero() || maxAge.isNegative()) {
                throw new IllegalArgumentException(
                        "krug.auth-bff.refresh-cookie.max-age must be positive");
            }
        }
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

    public record TwoFactor(
            Duration challengeTtl,
            int maxAttempts,
            int window,
            String issuer) {
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
            Duration resendIpWindow,
            int twoFactorPerUser,
            Duration twoFactorUserWindow,
            int twoFactorPerIp,
            Duration twoFactorIpWindow) {
    }

    public record Cleanup(
            boolean enabled,
            Duration pollInterval,
            Duration initialDelay,
            int batchSize,
            Duration consumedRetention) {
    }
}
