package ru.krug.backend.auth.infrastructure.scheduling;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import ru.krug.backend.auth.application.model.CleanupReport;
import ru.krug.backend.auth.application.usecase.EmailVerificationCleanupService;

/**
 * Purges expired email confirmations and their still-disabled Keycloak users. Logs counts
 * only — never an email address or a code.
 */
@Component
@ConditionalOnProperty(name = "krug.auth-bff.cleanup.enabled", havingValue = "true",
        matchIfMissing = true)
public class AuthEmailVerificationCleanupScheduler {

    private static final Logger log =
            LoggerFactory.getLogger(AuthEmailVerificationCleanupScheduler.class);

    private final EmailVerificationCleanupService cleanup;

    public AuthEmailVerificationCleanupScheduler(EmailVerificationCleanupService cleanup) {
        this.cleanup = cleanup;
    }

    @Scheduled(fixedDelayString = "${krug.auth-bff.cleanup.poll-interval:10m}",
            initialDelayString = "${krug.auth-bff.cleanup.initial-delay:2m}")
    public void purge() {
        try {
            CleanupReport report = cleanup.run();
            log.info("auth-email-verification.cleanup expired={} users={} consumed={}",
                    report.expiredRows(), report.deletedKeycloakUsers(), report.consumedRows());
        } catch (RuntimeException ex) {
            log.warn("auth-email-verification.cleanup_failed type={}",
                    ex.getClass().getSimpleName());
        }
    }
}
