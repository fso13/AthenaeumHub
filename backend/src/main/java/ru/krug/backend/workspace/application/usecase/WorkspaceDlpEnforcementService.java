package ru.krug.backend.workspace.application.usecase;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;

import ru.krug.backend.message.application.port.DlpGuardPort;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.ContentDlpPort;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;
import ru.krug.backend.workspace.application.port.DlpEventAppender;
import ru.krug.backend.workspace.domain.model.DlpAction;
import ru.krug.backend.workspace.domain.model.DlpEvent;
import ru.krug.backend.workspace.domain.model.DlpPolicy;
import ru.krug.backend.workspace.domain.model.DlpSurface;
import ru.krug.backend.workspace.domain.model.WorkspaceSecuritySettings;
import ru.krug.backend.workspace.domain.repository.DlpPolicyRepository;
import ru.krug.backend.workspace.domain.repository.WorkspaceSecuritySettingsRepository;
import ru.krug.backend.workspace.domain.service.DlpMatcher;

/**
 * Evaluates workspace DLP rules on every MANAGED content surface (#101): message text,
 * message edits, attachment metadata (upload/bind/rename) and plugin payloads.
 *
 * <p>The matcher is literal (keyword substring or {@code *} glob); no regular expression
 * is compiled, so a rule such as {@code (a+)+$} cannot cause ReDoS. A BLOCK match writes
 * the content-free event in an independent transaction and then throws {@code 422
 * DLP_BLOCKED}; the caller's transaction rolls back and no content is persisted. A WARN
 * match appends the event to the caller's transaction and lets it commit. This service
 * never sees or stores the evaluated value beyond the boolean match result — only ids,
 * the rule name snapshot, the surface and the timestamp reach the event log.</p>
 */
@Service
public class WorkspaceDlpEnforcementService implements DlpGuardPort, ContentDlpPort {

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
        enforceText(principal, chatId, text);
    }

    @Override
    public void enforceText(Principal principal, UUID chatId, String text) {
        if (text == null || text.isEmpty()) {
            return;
        }
        evaluate(principal, chatId, DlpSurface.TEXT, List.of(text), null);
    }

    @Override
    public void enforceAttachment(Principal principal, UUID chatId, String filename,
                                  String mimeType, long sizeBytes) {
        if ((filename == null || filename.isBlank())
                && (mimeType == null || mimeType.isBlank())) {
            return;
        }
        List<String> haystacks = DlpMatcher.attachmentHaystacks(filename, mimeType);
        evaluate(principal, chatId, DlpSurface.ATTACHMENT, haystacks, sizeBytes);
    }

    @Override
    public void enforcePluginPayload(Principal principal, UUID chatId, List<String> fields) {
        List<String> values = new ArrayList<>();
        if (fields != null) {
            for (String field : fields) {
                if (field != null && !field.isBlank()) {
                    // Each field is a separate haystack: a keyword never matches across a
                    // field boundary and no joined payload is ever materialised.
                    values.add(field);
                }
            }
        }
        if (values.isEmpty()) {
            return;
        }
        evaluate(principal, chatId, DlpSurface.PLUGIN, values, null);
    }

    private void evaluate(Principal principal, UUID chatId, DlpSurface surface,
                          List<String> haystacks, Long sizeBytes) {
        UUID workspaceId = principal == null ? null : principal.workspaceId();
        if (workspaceId == null) {
            return;
        }
        WorkspaceSecuritySettings current = settings.find(workspaceId).orElse(null);
        if (current == null || !current.dlpEnabled()) {
            return;
        }

        DlpPolicy block = null;
        DlpPolicy warn = null;
        for (DlpPolicy policy : policies.findAll(workspaceId)) {
            if (!policy.enabled() || !policy.scope().appliesTo(surface)) {
                continue;
            }
            boolean matched = DlpMatcher.matchesAny(haystacks, policy)
                    || (surface == DlpSurface.ATTACHMENT
                        && policy.maxFileSizeBytes() != null
                        && sizeBytes != null
                        && sizeBytes > policy.maxFileSizeBytes());
            if (!matched) {
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
            try {
                // The caller's transaction is about to roll back; persist the decision
                // independently so a blocked attempt is still visible to OWNER/ADMIN.
                events.appendIndependently(principal, event(principal, chatId, block));
            } catch (RuntimeException ignored) {
                // Fail closed: the block itself must not depend on the event insert. No
                // exception message is logged because it could contain SQL parameters.
            }
            throw DomainException.unprocessable(ErrorCode.DLP_BLOCKED,
                    "The content is blocked by a DLP policy",
                    Map.of("policy_id", block.id().toString(), "action", "BLOCK",
                            "surface", surface.name()));
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
