package ru.krug.backend.auth.application.usecase;

import java.time.Duration;
import java.time.Instant;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.auth.application.model.ResendPlan;
import ru.krug.backend.auth.application.port.AuthBffSettings;
import ru.krug.backend.auth.application.port.EmailCodePort;
import ru.krug.backend.auth.domain.model.EmailVerification;
import ru.krug.backend.auth.domain.repository.EmailVerificationRepository;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.error.DomainException;

/** Locks the row, enforces the resend cooldown and rotates the TOTP secret. */
@Service
public class ResendEmailCodeTx {

    private final EmailVerificationRepository verifications;
    private final EmailCodePort emailCode;
    private final AuthBffSettings settings;
    private final ClockPort clock;

    public ResendEmailCodeTx(EmailVerificationRepository verifications, EmailCodePort emailCode,
                             AuthBffSettings settings, ClockPort clock) {
        this.verifications = verifications;
        this.emailCode = emailCode;
        this.settings = settings;
        this.clock = clock;
    }

    @Transactional(noRollbackFor = DomainException.class)
    public ResendPlan prepare(UUID verificationId) {
        Instant now = clock.now();
        EmailVerification verification = verifications.findByIdForUpdate(verificationId)
                .orElseThrow(AuthBffErrors::verificationNotFound);
        if (verification.isConsumed() || verification.isExpired(now)) {
            throw AuthBffErrors.codeExpired();
        }
        if (verification.isLocked(settings.maxAttempts())) {
            throw AuthBffErrors.verificationLocked(settings.maxAttempts(),
                    verification.secondsUntilExpiry(now));
        }
        Duration cooldown = settings.resendCooldown();
        if (!verification.canResend(now, cooldown)) {
            long wait = cooldown.toSeconds()
                    - Duration.between(verification.lastSentAt(), now).toSeconds();
            throw DomainException.rateLimited(Math.max(1, wait), java.util.Map.of(
                    "scope", "resend",
                    "retry_after", Math.max(1, wait)));
        }

        String secret = emailCode.newSecret();
        String code = emailCode.code(secret, now);
        EmailVerification updated = verification.withNewSecret(secret, now);
        verifications.save(updated);
        return new ResendPlan(updated.id(), updated.email(), updated.displayName(), code,
                updated.secondsUntilExpiry(now), Math.max(0, cooldown.toSeconds()));
    }
}
