package ru.krug.backend.ops.application.usecase;

import java.util.Map;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.audit.application.model.AuditRecord;
import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.auth.application.usecase.PlatformAdminGuard;
import ru.krug.backend.ops.application.port.TestEmailException;
import ru.krug.backend.ops.application.port.TestEmailPort;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/** {@code POST /admin/settings/test-email}: synchronous SMTP probe, audited (no recipient). */
@Service
public class SendTestEmailService {

    private final PlatformAdminGuard adminGuard;
    private final TestEmailPort testEmail;
    private final AuditPort audit;
    private final ClockPort clock;

    public SendTestEmailService(PlatformAdminGuard adminGuard, TestEmailPort testEmail,
                                AuditPort audit, ClockPort clock) {
        this.adminGuard = adminGuard;
        this.testEmail = testEmail;
        this.audit = audit;
        this.clock = clock;
    }

    @Transactional
    public void send(Principal principal, String to) {
        adminGuard.require(principal);
        try {
            testEmail.sendTestEmail(to);
        } catch (TestEmailException ex) {
            throw DomainException.serviceUnavailable(ErrorCode.SMTP_UNAVAILABLE,
                    "SMTP delivery failed", Map.of("reason", "smtp_unavailable"), 5L);
        }
        audit.append(new AuditRecord(null, principal.userId(), "settings.test_email",
                "system_settings", null, principal.requestId(), Map.of("delivered", true),
                clock.now()));
    }
}
