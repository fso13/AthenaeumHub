package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Duration;
import java.util.UUID;

import org.junit.jupiter.api.Test;

import ru.krug.backend.ops.infrastructure.ratelimit.InMemoryRateLimiter;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;
import ru.krug.backend.support.TestProperties;

class InMemoryRateLimiterTest {

    private static final Principal PRINCIPAL = new Principal(UUID.randomUUID(), UUID.randomUUID(),
            UUID.randomUUID(), "req_test");

    @Test
    void allowsUpToTheLimitAndThenReturns429() {
        InMemoryRateLimiter limiter = new InMemoryRateLimiter(
                TestProperties.withRateLimit(2, Duration.ofSeconds(10), 100, true));
        UUID chat = UUID.randomUUID();

        assertThatCode(() -> {
            limiter.checkMessageSend(PRINCIPAL, chat);
            limiter.checkMessageSend(PRINCIPAL, chat);
        }).doesNotThrowAnyException();

        assertThatThrownBy(() -> limiter.checkMessageSend(PRINCIPAL, chat))
                .isInstanceOfSatisfying(DomainException.class, ex -> {
                    assertThat(ex.category().name()).isEqualTo("RATE_LIMITED");
                    assertThat(ex.code()).isEqualTo(ErrorCode.RATE_LIMITED);
                    assertThat(ex.retryAfterSeconds()).isNotNull().isGreaterThanOrEqualTo(1);
                });
    }

    @Test
    void doesNothingWhenDisabled() {
        InMemoryRateLimiter limiter = new InMemoryRateLimiter(
                TestProperties.withRateLimit(1, Duration.ofSeconds(10), 1, false));
        UUID chat = UUID.randomUUID();
        for (int i = 0; i < 5; i++) {
            limiter.checkMessageSend(PRINCIPAL, chat);
        }
    }

    @Test
    void botCommandAndResponseHaveIndependentOneTimeWindows() {
        InMemoryRateLimiter limiter = new InMemoryRateLimiter(
                TestProperties.withBotCommandRateLimit(2, Duration.ofSeconds(10), 2,
                        Duration.ofSeconds(10)));
        UUID chat = UUID.randomUUID();
        UUID token = UUID.randomUUID();
        UUID bot = UUID.randomUUID();

        assertThatCode(() -> {
            limiter.checkBotCommand(PRINCIPAL, chat);
            limiter.checkBotCommand(PRINCIPAL, chat);
        }).doesNotThrowAnyException();
        assertThatThrownBy(() -> limiter.checkBotCommand(PRINCIPAL, chat))
                .isInstanceOfSatisfying(DomainException.class, ex -> {
                    assertThat(ex.code()).isEqualTo(ErrorCode.RATE_LIMITED);
                    assertThat(ex.details().get("scope")).isEqualTo("user");
                });

        assertThatCode(() -> {
            limiter.checkBotResponse(token, bot);
            limiter.checkBotResponse(token, bot);
        }).doesNotThrowAnyException();
        assertThatThrownBy(() -> limiter.checkBotResponse(token, bot))
                .isInstanceOfSatisfying(DomainException.class, ex -> {
                    assertThat(ex.code()).isEqualTo(ErrorCode.RATE_LIMITED);
                    assertThat(ex.details().get("scope")).isEqualTo("token");
                });
    }

    @Test
    void botSendHasItsOwnPerBotWindow() {
        InMemoryRateLimiter limiter = new InMemoryRateLimiter(
                TestProperties.withBotRateLimit(2, Duration.ofSeconds(10), 100));
        UUID bot = UUID.randomUUID();

        assertThatCode(() -> {
            limiter.checkBotSend(bot, UUID.randomUUID());
            limiter.checkBotSend(bot, UUID.randomUUID());
        }).doesNotThrowAnyException();

        assertThatThrownBy(() -> limiter.checkBotSend(bot, UUID.randomUUID()))
                .isInstanceOfSatisfying(DomainException.class, ex -> {
                    assertThat(ex.category().name()).isEqualTo("RATE_LIMITED");
                    assertThat(ex.code()).isEqualTo(ErrorCode.RATE_LIMITED);
                    assertThat(ex.details().get("scope")).isEqualTo("bot");
                    assertThat(ex.retryAfterSeconds()).isNotNull().isGreaterThanOrEqualTo(1);
                });
    }
}
