package ru.krug.backend.workspace.application.usecase;

import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;

import ru.krug.backend.message.application.port.DlpGuardPort;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;
import ru.krug.backend.workspace.application.port.DlpEventAppender;
import ru.krug.backend.workspace.domain.model.DlpAction;
import ru.krug.backend.workspace.domain.model.DlpEvent;
import ru.krug.backend.workspace.domain.model.DlpPolicy;
import ru.krug.backend.workspace.domain.model.WorkspaceSecuritySettings;
import ru.krug.backend.workspace.domain.repository.DlpPolicyRepository;
import ru.krug.backend.workspace.domain.repository.WorkspaceSecuritySettingsRepository;
import ru.krug.backend.workspace.domain.service.DlpMatcher;

/**
 * Evaluates workspace DLP rules for a MANAGED text message (P0-3). Runs inside the message
 * transaction, so a WARN event commits atomically with the message.
 *
 * <p>The matcher is literal (keyword substring or {@code *} glob); no regular expression
 * is compiled, so a rule such as {@code (a+)+$} cannot cause ReDoS. A BLOCK match writes
 * the content-free event in an independent transaction and then throws
 * {@code 422 DLP_BLOCKED}; the message and its idempotency reservation roll back. This
 * service never sees or stores message text — only the boolean match result and ids reach
 * the event log.</p>
 */
@Service
public class WorkspaceDlpEnforcementService implements DlpGuardPort {

    private final WorkspaceSecuritySettingsRepository settings;
    private final DlpPolicyRepository policies;
    private final DlpEventAppender events;
    private final ClockPort clock;

    public WorkspaceDlpEnforcementService(WorkspaceSecuritySettingsRepository settings,
                                          DlpPolicyRepository policies,
                                          DlpEventAppender events, ClockPort clock) {
        this.settings = settings;
        this.policies = policies;
        this.events = events;
        this.clock = clock;
    }

    @Override
    public void enforce(Principal principal, UUID chatId, String text) {
        UUID workspaceId = principal.workspaceId();
        if (workspaceId == null || text == null || text.isEmpty()) {
            return;
        }
        WorkspaceSecuritySettings current = settings.find(workspaceId).orElse(null);
        if (current == null || !current.dlpEnabled()) {
            return;
        }

        DlpPolicy block = null;
        DlpPolicy warn = null;
        for (DlpPolicy policy : policies.findAll(workspaceId)) {
            if (!policy.enabled() || !DlpMatcher.matches(text, policy)) {
                continue;
            }
            if (policy.action() == DlpAction.BLOCK) {
                block = policy;
                break;
            }
            if (warn == null) {
                warn = policy;
            }
        }

        if (block != null) {
            DlpEvent event = event(principal, chatId, block);
            try {
                // The message transaction is about to roll back; persist the decision
                // independently so a blocked attempt is still visible to OWNER/ADMIN.
                events.appendIndependently(principal, event);
            } catch (RuntimeException ignored) {
                // Fail closed: the block itself must not depend on the event insert. No
                // exception message is logged because it could contain SQL parameters.
            }
            throw DomainException.unprocessable(ErrorCode.DLP_BLOCKED,
                    "The message is blocked by a DLP policy",
                    Map.of("policy_id", block.id().toString(), "action", "BLOCK"));
        }
        if (warn != null) {
            events.append(event(principal, chatId, warn));
        }
    }

    private DlpEvent event(Principal principal, UUID chatId, DlpPolicy policy) {
        return new DlpEvent(UUID.randomUUID(), principal.workspaceId(), policy.id(),
                policy.name(), policy.action(), principal.userId(), chatId, clock.now());
    }
}
