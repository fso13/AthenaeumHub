package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;

import ru.krug.backend.auth.infrastructure.ratelimit.AuthRateLimiter;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;
import ru.krug.backend.support.AuthBffTestData;

class AuthRateLimiterTest {

    @Test
    void loginWindowIsPerEmailAndFailsClosedWithRetryAfter() {
        AuthRateLimiter limiter =
                new AuthRateLimiter(AuthBffTestData.withRateLimitEnabled(true));
        for (int attempt = 1; attempt <= 10; attempt++) {
            assertThatCode(() -> limiter.checkLogin(" User@Krug.Test ", "10.0.0.1"))
                    .doesNotThrowAnyException();
        }
        assertThatThrownBy(() -> limiter.checkLogin("user@krug.test", "10.0.0.2"))
                .isInstanceOfSatisfying(DomainException.class, ex -> {
                    assertThat(ex.code()).isEqualTo(ErrorCode.RATE_LIMITED);
                    assertThat(ex.retryAfterSeconds()).isGreaterThanOrEqualTo(1);
                    assertThat(ex.details()).containsEntry("scope", "email");
                });
    }

    @Test
    void registerAndResendHaveIndependentWindows() {
        AuthRateLimiter limiter =
                new AuthRateLimiter(AuthBffTestData.withRateLimitEnabled(true));
        for (int attempt = 1; attempt <= 5; attempt++) {
            limiter.checkRegister("new@krug.test", "10.0.0.1");
        }
        assertThatThrownBy(() -> limiter.checkRegister("NEW@krug.test", "10.0.0.1"))
                .isInstanceOfSatisfying(DomainException.class,
                        ex -> assertThat(ex.code()).isEqualTo(ErrorCode.RATE_LIMITED));
        assertThatCode(() -> limiter.checkResend("new@krug.test", "10.0.0.1"))
                .doesNotThrowAnyException();
    }

    @Test
    void disabledLimiterNeverThrows() {
        AuthRateLimiter limiter =
                new AuthRateLimiter(AuthBffTestData.withRateLimitEnabled(false));
        for (int attempt = 1; attempt <= 100; attempt++) {
            limiter.checkLogin("user@krug.test", "10.0.0.1");
            limiter.checkRegister("user@krug.test", "10.0.0.1");
            limiter.checkResend("user@krug.test", "10.0.0.1");
        }
        assertThat(true).isTrue();
    }
}
