package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import ru.krug.backend.auth.application.usecase.VerifyEmailTx;
import ru.krug.backend.auth.domain.model.EmailVerification;
import ru.krug.backend.auth.infrastructure.code.TotpEmailCodeAdapter;
import ru.krug.backend.auth.infrastructure.config.AuthBffSettingsAdapter;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;
import ru.krug.backend.support.AuthBffTestData;
import ru.krug.backend.support.InMemoryEmailVerificationRepository;
import ru.krug.backend.support.MutableClock;

class VerifyEmailTxTest {

    private static final Instant NOW = Instant.parse("2026-01-01T00:00:00Z");

    private InMemoryEmailVerificationRepository repository;
    private TotpEmailCodeAdapter codes;
    private MutableClock clock;
    private VerifyEmailTx tx;
    private EmailVerification verification;
    private String correctCode;

    @BeforeEach
    void setUp() {
        var properties = AuthBffTestData.properties();
        repository = new InMemoryEmailVerificationRepository();
        codes = new TotpEmailCodeAdapter(properties);
        clock = new MutableClock(NOW);
        tx = new VerifyEmailTx(repository, codes,
                new AuthBffSettingsAdapter(properties), clock);
        String secret = codes.newSecret();
        verification = EmailVerification.create(UUID.randomUUID(), "user@krug.test", "User",
                UUID.randomUUID(), secret, NOW.plus(Duration.ofMinutes(10)), NOW);
        repository.save(verification);
        correctCode = codes.code(secret, NOW);
    }

    @Test
    void correctCodeReturnsTheRowWithoutIncrementingAttempts() {
        EmailVerification result = tx.attempt(verification.id(), correctCode);
        assertThat(result.id()).isEqualTo(verification.id());
        assertThat(repository.row(verification.id()).attempts()).isZero();
        assertThat(tx.complete(verification.id())).isTrue();
        assertThat(repository.row(verification.id()).isConsumed()).isTrue();
        assertThat(tx.complete(verification.id())).isFalse();
    }

    @Test
    void wrongCodeIncrementsAttemptsAndReturns422() {
        assertThatThrownBy(() -> tx.attempt(verification.id(), wrong(correctCode)))
                .isInstanceOfSatisfying(DomainException.class,
                        ex -> assertThat(ex.code()).isEqualTo(ErrorCode.CODE_INVALID));
        assertThat(repository.row(verification.id()).attempts()).isEqualTo(1);
        assertThat(repository.row(verification.id()).isConsumed()).isFalse();
    }

    @Test
    void fiveWrongAttemptsEndWith429AndLockTheRow() {
        String wrong = wrong(correctCode);
        for (int attempt = 1; attempt <= 4; attempt++) {
            assertThatThrownBy(() -> tx.attempt(verification.id(), wrong))
                    .isInstanceOfSatisfying(DomainException.class,
                            ex -> assertThat(ex.code()).isEqualTo(ErrorCode.CODE_INVALID));
        }
        assertThatThrownBy(() -> tx.attempt(verification.id(), wrong))
                .isInstanceOfSatisfying(DomainException.class, ex -> {
                    assertThat(ex.code()).isEqualTo(ErrorCode.RATE_LIMITED);
                    assertThat(ex.retryAfterSeconds()).isNotNull();
                    assertThat(ex.details()).containsEntry("scope", "verification");
                });
        assertThat(repository.row(verification.id()).attempts()).isEqualTo(5);
        // The correct code cannot be used after the cap is reached.
        assertThatThrownBy(() -> tx.attempt(verification.id(), correctCode))
                .isInstanceOfSatisfying(DomainException.class,
                        ex -> assertThat(ex.code()).isEqualTo(ErrorCode.RATE_LIMITED));
    }

    @Test
    void expiredAndConsumedRowsReturn410() {
        clock.set(NOW.plus(Duration.ofMinutes(10)));
        assertThatThrownBy(() -> tx.attempt(verification.id(), correctCode))
                .isInstanceOfSatisfying(DomainException.class,
                        ex -> assertThat(ex.code()).isEqualTo(ErrorCode.CODE_EXPIRED));

        clock.set(NOW);
        repository.save(verification.consumed(NOW.plusSeconds(1)));
        assertThatThrownBy(() -> tx.attempt(verification.id(), correctCode))
                .isInstanceOfSatisfying(DomainException.class,
                        ex -> assertThat(ex.code()).isEqualTo(ErrorCode.CODE_EXPIRED));
    }

    @Test
    void unknownVerificationIs404() {
        assertThatThrownBy(() -> tx.attempt(UUID.randomUUID(), correctCode))
                .isInstanceOfSatisfying(DomainException.class,
                        ex -> assertThat(ex.code()).isEqualTo(ErrorCode.NOT_FOUND));
    }

    private static String wrong(String correct) {
        int last = correct.charAt(correct.length() - 1) - '0';
        return correct.substring(0, correct.length() - 1) + ((last + 1) % 10);
    }
}
