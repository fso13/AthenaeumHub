package ru.krug.backend.auth.application.usecase;

import java.util.UUID;

import org.springframework.stereotype.Service;

import ru.krug.backend.auth.application.model.EmailCodeMessage;
import ru.krug.backend.auth.application.model.ResendCodeView;
import ru.krug.backend.auth.application.model.ResendPlan;
import ru.krug.backend.auth.application.port.AuthRateLimitPort;
import ru.krug.backend.auth.application.port.MailDeliveryException;
import ru.krug.backend.auth.application.port.MailPort;
import ru.krug.backend.auth.domain.model.EmailVerification;
import ru.krug.backend.auth.domain.repository.EmailVerificationRepository;

/** {@code POST /auth/resend-email-code}. */
@Service
public class ResendEmailCodeService {

    private final EmailVerificationRepository verifications;
    private final ResendEmailCodeTx resendTx;
    private final AuthRateLimitPort rateLimit;
    private final MailPort mail;

    public ResendEmailCodeService(EmailVerificationRepository verifications,
                                  ResendEmailCodeTx resendTx, AuthRateLimitPort rateLimit,
                                  MailPort mail) {
        this.verifications = verifications;
        this.resendTx = resendTx;
        this.rateLimit = rateLimit;
        this.mail = mail;
    }

    public ResendCodeView resend(UUID verificationId, String clientIp) {
        EmailVerification verification = verifications.findById(verificationId)
                .orElseThrow(AuthBffErrors::verificationNotFound);
        rateLimit.checkResend(verification.email(), clientIp);

        ResendPlan plan = resendTx.prepare(verificationId);
        try {
            mail.sendEmailCode(new EmailCodeMessage(plan.email(), plan.displayName(),
                    plan.code(), (int) Math.max(1, (plan.expiresIn() + 59) / 60)));
        } catch (MailDeliveryException ex) {
            throw AuthBffErrors.authUnavailable("mail_unavailable");
        }
        return new ResendCodeView(plan.expiresIn(), plan.resendAfter());
    }
}
