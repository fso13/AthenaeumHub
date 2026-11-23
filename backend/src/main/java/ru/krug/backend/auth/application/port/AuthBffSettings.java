package ru.krug.backend.auth.application.port;

import java.time.Duration;

/**
 * Application-facing view of the Auth BFF configuration. Implemented in infrastructure by
 * {@code AuthBffSettingsAdapter}; keeps {@code AuthBffProperties} out of the application
 * layer (ArchUnit).
 */
public interface AuthBffSettings {

    boolean registrationEnabled();

    boolean trustForwardedFor();

    Duration codeExpiry();

    Duration resendCooldown();

    int maxAttempts();

    Duration pendingSessionTtl();

    int cleanupBatchSize();

    Duration cleanupConsumedRetention();

    Duration twoFactorChallengeTtl();

    int twoFactorMaxAttempts();

    int twoFactorWindow();

    String twoFactorIssuer();

    /**
     * Global installation policy (#91). When true every interactive login needs a second
     * factor: accounts with an authenticator get the TOTP challenge, the rest get an
     * ENROLL challenge and no session before enrollment completes.
     */
    boolean requireTwoFactor();

    /** #103: HttpOnly refresh-token cookie name (e.g. {@code sova_refresh}). */
    String refreshCookieName();

    /** #103: cookie path; narrowed to the Auth BFF so it is not sent to other APIs. */
    String refreshCookiePath();

    /** #103: true when the deployment is served over HTTPS (prod). */
    boolean refreshCookieSecure();

    /** #103: {@code Lax}, {@code Strict} or {@code None} (CSRF defence in depth). */
    String refreshCookieSameSite();

    /** #103: cookie lifetime; Keycloak remains the authority on token validity. */
    Duration refreshCookieMaxAge();
}
