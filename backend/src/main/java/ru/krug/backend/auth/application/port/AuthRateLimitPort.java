package ru.krug.backend.auth.application.port;

/**
 * Per-email/per-IP fixed-window limiter for the public auth endpoints. Fails closed with
 * {@code 429 RATE_LIMITED} and a {@code Retry-After} hint.
 */
public interface AuthRateLimitPort {

    void checkRegister(String email, String clientIp);

    void checkLogin(String email, String clientIp);

    void checkResend(String email, String clientIp);
}
