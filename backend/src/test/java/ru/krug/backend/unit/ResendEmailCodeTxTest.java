package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Duration;
import java.time.Instant;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import ru.krug.backend.auth.application.model.ResendPlan;
import ru.krug.backend.auth.application.usecase.ResendEmailCodeTx;
import ru.krug.backend.auth.domain.model.EmailVerification;
import ru.krug.backend.auth.infrastructure.code.TotpEmailCodeAdapter;
import ru.krug.backend.auth.infrastructure.config.AuthBffSettingsAdapter;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;
import ru.krug.backend.support.AuthBffTestData;
import ru.krug.backend.support.InMemoryEmailVerificationRepository;
import ru.krug.backend.support.MutableClock;

class ResendEmailCodeTxTest {

    private static final Instant NOW = Instant.parse("2026-01-01T00:00:00Z");

    private InMemoryEmailVerificationRepository repository;
    private MutableClock clock;
    private ResendEmailCodeTx tx;
    private EmailVerification verification;

    @BeforeEach
    void setUp() {
        var properties = AuthBffTestData.properties();
        repository = new InMemoryEmailVerificationRepository();
        clock = new MutableClock(NOW);
        tx = new ResendEmailCodeTx(repository, new TotpEmailCodeAdapter(properties),
                new AuthBffSettingsAdapter(properties), clock);
        verification = EmailVerification.create(UUID.randomUUID(), "user@krug.test", "User",
                UUID.randomUUID(), "b2xkLXNlY3JldA", NOW.plus(Duration.ofMinutes(10)), NOW);
        repository.save(verification);
    }

    @Test
    void enforcesTheSixtySecondCooldown() {
        clock.advanceSeconds(10);
        assertThatThrownBy(() -> tx.prepare(verification.id()))
                .isInstanceOfSatisfying(DomainException.class, ex -> {
                    assertThat(ex.code()).isEqualTo(ErrorCode.RATE_LIMITED);
                    assertThat(ex.details()).containsEntry("scope", "resend");
                    assertThat(ex.retryAfterSeconds()).isGreaterThanOrEqualTo(1);
                });
    }

    @Test
    void rotatesTheSecretButKeepsAttemptsAndExpiry() {
        repository.save(verification.withFailedAttempt().withFailedAttempt());
        clock.advanceSeconds(61);
        ResendPlan plan = tx.prepare(verification.id());

        EmailVerification updated = repository.row(verification.id());
        assertThat(plan.code()).matches("[0-9]{6}");
        assertThat(updated.secret()).isNotEqualTo(verification.secret());
        assertThat(updated.attempts()).isEqualTo(2);
        assertThat(updated.expiresAt()).isEqualTo(verification.expiresAt());
        assertThat(updated.lastSentAt()).isEqualTo(clock.now());
        assertThat(plan.resendAfter()).isEqualTo(60);
        assertThat(plan.expiresIn()).isEqualTo(539);
    }

    @Test
    void lockedOrExpiredOrConsumedRowsCannotBeResent() {
        repository.save(verification.withFailedAttempt().withFailedAttempt()
                .withFailedAttempt().withFailedAttempt().withFailedAttempt());
        clock.advanceSeconds(61);
        assertThatThrownBy(() -> tx.prepare(verification.id()))
                .isInstanceOfSatisfying(DomainException.class,
                        ex -> assertThat(ex.code()).isEqualTo(ErrorCode.RATE_LIMITED));

        clock.set(NOW.plus(Duration.ofMinutes(10)));
        assertThatThrownBy(() -> tx.prepare(verification.id()))
                .isInstanceOfSatisfying(DomainException.class,
                        ex -> assertThat(ex.code()).isEqualTo(ErrorCode.CODE_EXPIRED));
    }
}
