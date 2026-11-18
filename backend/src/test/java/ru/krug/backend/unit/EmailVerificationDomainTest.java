package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Duration;
import java.time.Instant;
import java.util.UUID;

import org.junit.jupiter.api.Test;

import ru.krug.backend.auth.domain.model.EmailVerification;

class EmailVerificationDomainTest {

    private static final Instant NOW = Instant.parse("2026-01-01T00:00:00Z");

    @Test
    void tracksAttemptsExpiryAndResendCooldown() {
        EmailVerification verification = EmailVerification.create(UUID.randomUUID(),
                "  USER@Krug.Test ", " Дмитрий ", UUID.randomUUID(), "secret",
                NOW.plus(Duration.ofMinutes(10)), NOW);

        assertThat(verification.email()).isEqualTo("user@krug.test");
        assertThat(verification.displayName()).isEqualTo("Дмитрий");
        assertThat(verification.isExpired(NOW.plusSeconds(599))).isFalse();
        assertThat(verification.isExpired(NOW.plusSeconds(600))).isTrue();
        assertThat(verification.canResend(NOW.plusSeconds(59), Duration.ofSeconds(60))).isFalse();
        assertThat(verification.canResend(NOW.plusSeconds(60), Duration.ofSeconds(60))).isTrue();

        EmailVerification afterFailure = verification.withFailedAttempt();
        assertThat(afterFailure.attempts()).isEqualTo(1);
        assertThat(afterFailure.isLocked(5)).isFalse();
        assertThat(afterFailure.withFailedAttempt().withFailedAttempt().withFailedAttempt()
                .withFailedAttempt().isLocked(5)).isTrue();
    }

    @Test
    void consumeIsFinalAndRotatingSecretKeepsAttemptsAndExpiry() {
        EmailVerification verification = EmailVerification.create(UUID.randomUUID(),
                "user@krug.test", "User", UUID.randomUUID(), "secret",
                NOW.plus(Duration.ofMinutes(10)), NOW).withFailedAttempt();
        EmailVerification rotated = verification.withNewSecret("new-secret", NOW.plusSeconds(60));
        assertThat(rotated.secret()).isEqualTo("new-secret");
        assertThat(rotated.attempts()).isEqualTo(1);
        assertThat(rotated.expiresAt()).isEqualTo(verification.expiresAt());
        assertThat(rotated.lastSentAt()).isEqualTo(NOW.plusSeconds(60));
        assertThat(rotated.isConsumed()).isFalse();
        assertThat(rotated.consumed(NOW.plusSeconds(120)).isConsumed()).isTrue();
    }

    @Test
    void rejectsInvalidRowsFromTheDatabaseBoundary() {
        assertThatThrownBy(() -> EmailVerification.create(UUID.randomUUID(), "a@b.c", " ",
                UUID.randomUUID(), "secret", NOW.plusSeconds(10), NOW))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> EmailVerification.create(UUID.randomUUID(), "a@b.c", "Name",
                UUID.randomUUID(), " ", NOW.plusSeconds(10), NOW))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> EmailVerification.create(UUID.randomUUID(), "a@b.c", "Name",
                UUID.randomUUID(), "secret", NOW, NOW))
                .isInstanceOf(IllegalArgumentException.class);
    }
}
