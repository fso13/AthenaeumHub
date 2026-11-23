package ru.krug.backend.support;

import java.time.Duration;

import ru.krug.backend.auth.infrastructure.config.AuthBffProperties;

/** Deterministic Auth BFF settings for unit tests (no Spring context). */
public final class AuthBffTestData {

    public static final String EMAIL_SECRET_KEY =
            "test-email-code-secret-key-please-change-32";
    public static final String MAIL_FROM = "no-reply@krug.test";

    private AuthBffTestData() {
    }

    public static AuthBffProperties properties() {
        return properties(true);
    }

    public static AuthBffProperties properties(boolean registrationEnabled) {
        return new AuthBffProperties(
                registrationEnabled,
                false,
                Duration.ofMinutes(15),
                new AuthBffProperties.Keycloak(
                        "http://localhost:9999", "krug", "master", "admin", "admin",
                        "admin-cli", "krug-web", "", "",
                        Duration.ofSeconds(2), Duration.ofSeconds(2), Duration.ofSeconds(10)),
                new AuthBffProperties.Mail(MAIL_FROM),
                new AuthBffProperties.Code(Duration.ofMinutes(10), Duration.ofSeconds(60), 5, 5,
                        EMAIL_SECRET_KEY),
                new AuthBffProperties.TwoFactor(Duration.ofMinutes(5), 5, 1, "Krug"),
                new AuthBffProperties.RateLimit(true, 5, Duration.ofHours(1), 20,
                        Duration.ofHours(1), 10, Duration.ofMinutes(1), 30,
                        Duration.ofMinutes(1), 5, Duration.ofMinutes(10), 10,
                        Duration.ofMinutes(10), 20, Duration.ofMinutes(5), 60,
                        Duration.ofMinutes(5)),
                new AuthBffProperties.Cleanup(true, Duration.ofMinutes(10),
                        Duration.ofMinutes(2), 200, Duration.ofHours(24)),
                new AuthBffProperties.RefreshCookie("sova_refresh", "/api/v1/auth", false,
                        "Lax", Duration.ofMinutes(30)));
    }

    public static AuthBffProperties withRegistrationClosed() {
        return properties(false);
    }

    public static AuthBffProperties withRateLimitEnabled(boolean enabled) {
        AuthBffProperties base = properties();
        return new AuthBffProperties(base.registrationEnabled(), base.trustForwardedFor(),
                base.pendingSessionTtl(), base.keycloak(), base.mail(), base.code(),
                base.twoFactor(),
                new AuthBffProperties.RateLimit(enabled,
                        base.rateLimit().registerPerEmail(),
                        base.rateLimit().registerEmailWindow(),
                        base.rateLimit().registerPerIp(),
                        base.rateLimit().registerIpWindow(),
                        base.rateLimit().loginPerEmail(),
                        base.rateLimit().loginEmailWindow(),
                        base.rateLimit().loginPerIp(),
                        base.rateLimit().loginIpWindow(),
                        base.rateLimit().resendPerEmail(),
                        base.rateLimit().resendEmailWindow(),
                        base.rateLimit().resendPerIp(),
                        base.rateLimit().resendIpWindow(),
                        base.rateLimit().twoFactorPerUser(),
                        base.rateLimit().twoFactorUserWindow(),
                        base.rateLimit().twoFactorPerIp(),
                        base.rateLimit().twoFactorIpWindow()),
                base.cleanup(),
                base.refreshCookie());
    }
}
