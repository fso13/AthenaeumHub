package ru.krug.backend.auth.application.usecase;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

import org.springframework.stereotype.Service;

import ru.krug.backend.auth.application.model.CleanupReport;
import ru.krug.backend.auth.application.model.KeycloakUserView;
import ru.krug.backend.auth.application.port.AuthBffSettings;
import ru.krug.backend.auth.application.port.KeycloakAdminPort;
import ru.krug.backend.auth.domain.model.EmailVerification;
import ru.krug.backend.auth.domain.repository.EmailVerificationRepository;
import ru.krug.backend.shared.application.port.ClockPort;

/**
 * Purges expired confirmations and deletes the still-disabled Keycloak user so the email
 * can be registered again. If Keycloak is unavailable the row is kept for the next tick.
 *
 * <p>Logs (in the scheduler) contain counts only: no email addresses or codes.</p>
 */
@Service
public class EmailVerificationCleanupService {

    private final EmailVerificationRepository verifications;
    private final KeycloakAdminPort keycloak;
    private final AuthBffSettings settings;
    private final ClockPort clock;

    public EmailVerificationCleanupService(EmailVerificationRepository verifications,
                                           KeycloakAdminPort keycloak,
                                           AuthBffSettings settings, ClockPort clock) {
        this.verifications = verifications;
        this.keycloak = keycloak;
        this.settings = settings;
        this.clock = clock;
    }

    public CleanupReport run() {
        Instant now = clock.now();
        List<EmailVerification> expired = verifications.findExpiredUnconsumed(
                now, settings.cleanupBatchSize());
        int deletedUsers = 0;
        int deletedRows = 0;
        for (EmailVerification verification : expired) {
            Optional<KeycloakUserView> user;
            try {
                user = keycloak.findById(verification.keycloakUserId());
            } catch (RuntimeException ex) {
                // Keycloak is down: keep the row and retry on the next tick.
                continue;
            }
            try {
                if (user.isPresent() && !user.get().enabled() && !user.get().emailVerified()) {
                    keycloak.deleteUser(verification.keycloakUserId());
                    deletedUsers++;
                }
                verifications.delete(verification.id());
                deletedRows++;
            } catch (RuntimeException ignored) {
                // Keep the row for a retry; one bad row must not stop the batch.
            }
        }
        int consumed = verifications.deleteConsumedBefore(
                now.minus(settings.cleanupConsumedRetention()), settings.cleanupBatchSize());
        return new CleanupReport(deletedRows, deletedUsers, consumed);
    }
}
