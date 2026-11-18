package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;

import ru.krug.backend.auth.application.model.CleanupReport;
import ru.krug.backend.auth.application.model.KeycloakUserView;
import ru.krug.backend.auth.application.port.AuthBffSettings;
import ru.krug.backend.auth.application.port.KeycloakAdminPort;
import ru.krug.backend.auth.application.port.ProviderUnavailableException;
import ru.krug.backend.auth.application.usecase.EmailVerificationCleanupService;
import ru.krug.backend.auth.domain.model.EmailVerification;
import ru.krug.backend.auth.domain.repository.EmailVerificationRepository;
import ru.krug.backend.shared.application.port.ClockPort;

@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class EmailVerificationCleanupServiceTest {

    private static final Instant NOW = Instant.parse("2026-01-01T00:00:00Z");

    @Mock
    private EmailVerificationRepository repository;
    @Mock
    private KeycloakAdminPort keycloak;
    @Mock
    private AuthBffSettings settings;
    @Mock
    private ClockPort clock;

    @InjectMocks
    private EmailVerificationCleanupService cleanup;

    private EmailVerification expired;

    @BeforeEach
    void setUp() {
        when(clock.now()).thenReturn(NOW);
        when(settings.cleanupBatchSize()).thenReturn(100);
        when(settings.cleanupConsumedRetention()).thenReturn(Duration.ofHours(24));
        expired = EmailVerification.create(UUID.randomUUID(), "user@krug.test", "User",
                UUID.randomUUID(), "secret", NOW.minusSeconds(60), NOW.minus(Duration.ofMinutes(11)));
        when(repository.findExpiredUnconsumed(NOW, 100)).thenReturn(List.of(expired));
        when(repository.deleteConsumedBefore(any(), any(Integer.class))).thenReturn(2);
    }

    @Test
    void deletesDisabledKeycloakUserAndTheExpiredRow() {
        when(keycloak.findById(expired.keycloakUserId())).thenReturn(Optional.of(
                new KeycloakUserView(expired.keycloakUserId(), "user@krug.test",
                        "user@krug.test", "User", false, false)));

        CleanupReport report = cleanup.run();

        verify(keycloak).deleteUser(expired.keycloakUserId());
        verify(repository).delete(expired.id());
        assertThat(report.expiredRows()).isEqualTo(1);
        assertThat(report.deletedKeycloakUsers()).isEqualTo(1);
        assertThat(report.consumedRows()).isEqualTo(2);
    }

    @Test
    void keepsTheRowWhenKeycloakIsUnavailable() {
        when(keycloak.findById(expired.keycloakUserId()))
                .thenThrow(new ProviderUnavailableException());

        CleanupReport report = cleanup.run();

        verify(repository, never()).delete(expired.id());
        verify(keycloak, never()).deleteUser(any());
        assertThat(report.expiredRows()).isZero();
    }

    @Test
    void doesNotDeleteAnAlreadyVerifiedUser() {
        when(keycloak.findById(expired.keycloakUserId())).thenReturn(Optional.of(
                new KeycloakUserView(expired.keycloakUserId(), "user@krug.test",
                        "user@krug.test", "User", true, true)));

        cleanup.run();

        verify(keycloak, never()).deleteUser(any());
        verify(repository).delete(expired.id());
    }
}
