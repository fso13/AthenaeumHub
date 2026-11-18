package ru.krug.backend.auth.application.usecase;

import java.time.Instant;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.auth.application.port.AuthBffSettings;
import ru.krug.backend.auth.application.port.EmailCodePort;
import ru.krug.backend.auth.domain.model.EmailVerification;
import ru.krug.backend.auth.domain.repository.EmailVerificationRepository;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.error.DomainException;

/**
 * Transaction boundary for code validation. Attempts are committed even when the code is
 * rejected ({@code noRollbackFor = DomainException.class}), otherwise the 5-attempt cap
 * could be bypassed by replaying the endpoint.
 */
@Service
public class VerifyEmailTx {

    private final EmailVerificationRepository verifications;
    private final EmailCodePort emailCode;
    private final AuthBffSettings settings;
    private final ClockPort clock;

    public VerifyEmailTx(EmailVerificationRepository verifications, EmailCodePort emailCode,
                         AuthBffSettings settings, ClockPort clock) {
        this.verifications = verifications;
        this.emailCode = emailCode;
        this.settings = settings;
        this.clock = clock;
    }

    @Transactional(noRollbackFor = DomainException.class)
    public EmailVerification attempt(UUID verificationId, String code) {
        Instant now = clock.now();
        EmailVerification verification = verifications.findByIdForUpdate(verificationId)
                .orElseThrow(AuthBffErrors::verificationNotFound);
        if (verification.isConsumed() || verification.isExpired(now)) {
            throw AuthBffErrors.codeExpired();
        }
        int maxAttempts = settings.maxAttempts();
        if (verification.isLocked(maxAttempts)) {
            throw AuthBffErrors.verificationLocked(maxAttempts,
                    verification.secondsUntilExpiry(now));
        }
        if (!emailCode.matches(verification.secret(), code, now)) {
            EmailVerification updated = verification.withFailedAttempt();
            verifications.save(updated);
            if (updated.isLocked(maxAttempts)) {
                throw AuthBffErrors.verificationLocked(maxAttempts,
                        updated.secondsUntilExpiry(now));
            }
            throw AuthBffErrors.codeInvalid(maxAttempts - updated.attempts());
        }
        return verification;
    }

    @Transactional
    public boolean complete(UUID verificationId) {
        return verifications.markConsumed(verificationId, clock.now()) == 1;
    }
}
