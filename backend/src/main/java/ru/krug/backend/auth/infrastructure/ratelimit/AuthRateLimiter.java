package ru.krug.backend.auth.infrastructure.ratelimit;

import java.time.Duration;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import org.springframework.stereotype.Component;

import ru.krug.backend.auth.application.port.AuthRateLimitPort;
import ru.krug.backend.auth.infrastructure.config.AuthBffProperties;
import ru.krug.backend.shared.error.DomainException;

/**
 * In-memory fixed-window limiter for the public auth endpoints (register/resend/login),
 * keyed per email and per client IP. Fails closed: an exhausted window is a 429 with
 * {@code Retry-After}. Redis token bucket is the multi-node production replacement.
 */
@Component
public class AuthRateLimiter implements AuthRateLimitPort {

    private record Window(long startNanos, int count) {
    }

    private record Limit(int count, long windowNanos) {
    }

    private final boolean enabled;
    private final Limit registerPerEmail;
    private final Limit registerPerIp;
    private final Limit loginPerEmail;
    private final Limit loginPerIp;
    private final Limit resendPerEmail;
    private final Limit resendPerIp;
    private final ConcurrentHashMap<String, Window> windows = new ConcurrentHashMap<>();

    public AuthRateLimiter(AuthBffProperties properties) {
        AuthBffProperties.RateLimit config = properties.rateLimit();
        this.enabled = config.enabled();
        this.registerPerEmail = limit(config.registerPerEmail(), config.registerEmailWindow());
        this.registerPerIp = limit(config.registerPerIp(), config.registerIpWindow());
        this.loginPerEmail = limit(config.loginPerEmail(), config.loginEmailWindow());
        this.loginPerIp = limit(config.loginPerIp(), config.loginIpWindow());
        this.resendPerEmail = limit(config.resendPerEmail(), config.resendEmailWindow());
        this.resendPerIp = limit(config.resendPerIp(), config.resendIpWindow());
    }

    @Override
    public void checkRegister(String email, String clientIp) {
        if (!enabled) {
            return;
        }
        enforce("register:email:" + normalize(email), registerPerEmail, "email");
        enforce("register:ip:" + normalize(clientIp), registerPerIp, "ip");
    }

    @Override
    public void checkLogin(String email, String clientIp) {
        if (!enabled) {
            return;
        }
        enforce("login:email:" + normalize(email), loginPerEmail, "email");
        enforce("login:ip:" + normalize(clientIp), loginPerIp, "ip");
    }

    @Override
    public void checkResend(String email, String clientIp) {
        if (!enabled) {
            return;
        }
        enforce("resend:email:" + normalize(email), resendPerEmail, "email");
        enforce("resend:ip:" + normalize(clientIp), resendPerIp, "ip");
    }

    private static Limit limit(int count, Duration window) {
        long nanos = window == null || window.isZero() || window.isNegative()
                ? Duration.ofMinutes(1).toNanos()
                : window.toNanos();
        return new Limit(Math.max(1, count), nanos);
    }

    private void enforce(String key, Limit limit, String scope) {
        long now = System.nanoTime();
        Window window = windows.compute(key, (ignored, current) -> {
            if (current == null || now - current.startNanos() >= limit.windowNanos()) {
                return new Window(now, 1);
            }
            return new Window(current.startNanos(), current.count() + 1);
        });
        if (window.count() > limit.count()) {
            long elapsed = now - window.startNanos();
            long retryAfter = Math.max(1,
                    (limit.windowNanos() - elapsed + 999_999_999L) / 1_000_000_000L);
            throw DomainException.rateLimited(retryAfter, Map.of(
                    "scope", scope,
                    "limit", limit.count(),
                    "window_seconds", Math.max(1,
                            Duration.ofNanos(limit.windowNanos()).toSeconds())));
        }
        if (windows.size() > 50_000) {
            windows.entrySet().removeIf(
                    entry -> now - entry.getValue().startNanos() > 3_600_000_000_000L);
        }
    }

    private static String normalize(String value) {
        return value == null ? "unknown" : value.strip().toLowerCase(java.util.Locale.ROOT);
    }
}
