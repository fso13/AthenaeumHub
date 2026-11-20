package ru.krug.backend.auth.application.port;

/**
 * Per-email/per-IP fixed-window limiter for the public auth endpoints. Fails closed with
 * {@code 429 RATE_LIMITED} and a {@code Retry-After} hint.
 */
public interface AuthRateLimitPort {

    void checkRegister(String email, String clientIp);

    void checkLogin(String email, String clientIp);

    void checkResend(String email, String clientIp);

    /**
     * P0-4: authenticator setup/verify/disable, recovery-code regeneration and the login
     * challenge. Keyed by the authenticated user id (verified challenges additionally by
     * client IP), so a stolen access token cannot brute-force the password/TOTP code.
     */
    void checkTwoFactor(String userId, String clientIp);
}
