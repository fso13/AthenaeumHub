package ru.krug.backend.workspace.application.usecase;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.audit.application.model.AuditRecord;
import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;
import ru.krug.backend.workspace.application.command.CreateDlpPolicyCommand;
import ru.krug.backend.workspace.application.command.UpdateDlpPolicyCommand;
import ru.krug.backend.workspace.application.model.DlpPolicyView;
import ru.krug.backend.workspace.application.model.WorkspaceSecurityContext;
import ru.krug.backend.workspace.application.service.DlpPolicyRequests;
import ru.krug.backend.workspace.application.service.WorkspaceSecurityActions;
import ru.krug.backend.workspace.domain.model.DlpAction;
import ru.krug.backend.workspace.domain.model.DlpPatternType;
import ru.krug.backend.workspace.domain.model.DlpPolicy;
import ru.krug.backend.workspace.domain.repository.DlpPolicyRepository;

/**
 * {@code /workspaces/{id}/dlp/policies} (P0-3). OWNER/ADMIN only; MANAGED workspaces only
 * (E2EE content is opaque, so a DLP rule cannot work). Patterns are literal bounded values
 * — no regular expression is ever compiled, so a rule cannot cause ReDoS. The audit event
 * records ids/action/type/enabled only; the pattern text is never written to the audit
 * chain.
 */
@Service
public class DlpPolicyService {

    private static final String TARGET_TYPE = "dlp_policy";

    private final WorkspaceSecurityGuard guard;
    private final DlpPolicyRepository policies;
    private final AuditPort audit;
    private final ClockPort clock;

    public DlpPolicyService(WorkspaceSecurityGuard guard, DlpPolicyRepository policies,
                            AuditPort audit, ClockPort clock) {
        this.guard = guard;
        this.policies = policies;
        this.audit = audit;
        this.clock = clock;
    }

    @Transactional(readOnly = true)
    public List<DlpPolicyView> list(Principal principal, UUID workspaceId) {
        WorkspaceSecurityContext context = guard.requireManager(principal, workspaceId);
        if (context.e2ee()) {
            // E2EE content is opaque; there can be no usable rule. The UI gets an empty
            // list instead of a confusing error, while mutations stay rejected.
            return List.of();
        }
        return policies.findAll(workspaceId).stream().map(DlpPolicyService::view).toList();
    }

    @Transactional
    public DlpPolicyView create(Principal principal, UUID workspaceId,
                                CreateDlpPolicyCommand command) {
        WorkspaceSecurityContext context = guard.requireManager(principal, workspaceId);
        requireManaged(context);

        String name = DlpPolicyRequests.name(command.name());
        DlpAction action = DlpPolicyRequests.action(command.action());
        DlpPatternType type = DlpPolicyRequests.patternType(command.patternType());
        String pattern = DlpPolicyRequests.pattern(command.pattern(), type);
        boolean enabled = DlpPolicyRequests.enabled(command.enabled());

        if (policies.count(workspaceId) >= DlpPolicyRequests.MAX_POLICIES_PER_WORKSPACE) {
            throw DomainException.conflict(ErrorCode.DLP_POLICY_LIMIT,
                    "The workspace DLP policy limit is reached",
                    Map.of("limit", DlpPolicyRequests.MAX_POLICIES_PER_WORKSPACE));
        }
        if (policies.nameTaken(workspaceId, name, null)) {
            throw nameTaken();
        }

        Instant now = clock.now();
        DlpPolicy policy = new DlpPolicy(UUID.randomUUID(), workspaceId, name, action, type,
                pattern, enabled, principal.userId(), now, now);
        if (!policies.insert(policy)) {
            // The unique (workspace_id, lower(name)) index won a concurrent create.
            throw nameTaken();
        }
        audit.append(new AuditRecord(workspaceId, principal.userId(),
                WorkspaceSecurityActions.DLP_POLICY_CREATED, TARGET_TYPE, policy.id(),
                principal.requestId(),
                Map.of("policy_id", policy.id().toString(), "action", action.name(),
                        "pattern_type", type.name(), "enabled", enabled),
                clock.now()));
        return view(policy);
    }

    @Transactional
    public DlpPolicyView update(Principal principal, UUID workspaceId, UUID policyId,
                                UpdateDlpPolicyCommand command) {
        WorkspaceSecurityContext context = guard.requireManager(principal, workspaceId);
        requireManaged(context);
        if (command == null || command.isEmpty()) {
            throw DomainException.badRequest("At least one field must be provided",
                    Map.of("field", "body"));
        }
        DlpPolicy existing = policies.findById(workspaceId, policyId)
                .orElseThrow(() -> DomainException.notFound("DLP policy not found"));

        String name = command.name() == null
                ? existing.name() : DlpPolicyRequests.name(command.name());
        DlpAction action = command.action() == null
                ? existing.action() : DlpPolicyRequests.action(command.action());
        DlpPatternType type = command.patternType() == null
                ? existing.patternType() : DlpPolicyRequests.patternType(command.patternType());
        String pattern = command.pattern() == null
                ? existing.pattern() : command.pattern();
        // Re-validate the merged pair: a type change also re-checks the wildcard bound.
        pattern = DlpPolicyRequests.pattern(pattern, type);
        boolean enabled = command.enabled() == null ? existing.enabled() : command.enabled();

        List<String> changed = changed(existing, name, action, type, pattern, enabled);
        if (changed.isEmpty()) {
            return view(existing);
        }
        if (changed.contains("name") && policies.nameTaken(workspaceId, name, policyId)) {
            throw nameTaken();
        }

        DlpPolicy updated = existing.withDetails(name, action, type, pattern, enabled,
                clock.now());
        if (!policies.update(updated)) {
            throw DomainException.notFound("DLP policy not found");
        }
        audit.append(new AuditRecord(workspaceId, principal.userId(),
                WorkspaceSecurityActions.DLP_POLICY_UPDATED, TARGET_TYPE, policyId,
                principal.requestId(),
                Map.of("policy_id", policyId.toString(), "changed", changed,
                        "action", action.name(), "pattern_type", type.name(),
                        "enabled", enabled),
                clock.now()));
        return view(updated);
    }

    @Transactional
    public void delete(Principal principal, UUID workspaceId, UUID policyId) {
        WorkspaceSecurityContext context = guard.requireManager(principal, workspaceId);
        requireManaged(context);
        DlpPolicy existing = policies.findById(workspaceId, policyId)
                .orElseThrow(() -> DomainException.notFound("DLP policy not found"));
        if (!policies.delete(workspaceId, policyId)) {
            throw DomainException.notFound("DLP policy not found");
        }
        audit.append(new AuditRecord(workspaceId, principal.userId(),
                WorkspaceSecurityActions.DLP_POLICY_DELETED, TARGET_TYPE, policyId,
                principal.requestId(),
                Map.of("policy_id", policyId.toString(), "action", existing.action().name(),
                        "pattern_type", existing.patternType().name()),
                clock.now()));
    }

    private static void requireManaged(WorkspaceSecurityContext context) {
        if (context.e2ee()) {
            throw DomainException.unprocessable(ErrorCode.DLP_E2EE_UNSUPPORTED,
                    "DLP policies are available only in MANAGED workspaces",
                    Map.of("field", "security_mode", "security_mode", "E2EE"));
        }
    }

    private static DomainException nameTaken() {
        return DomainException.conflict(ErrorCode.DLP_POLICY_NAME_TAKEN,
                "A DLP policy with this name already exists", Map.of("field", "name"));
    }

    private static List<String> changed(DlpPolicy existing, String name, DlpAction action,
                                        DlpPatternType type, String pattern, boolean enabled) {
        List<String> changed = new ArrayList<>();
        if (!Objects.equals(existing.name(), name)) {
            changed.add("name");
        }
        if (existing.action() != action) {
            changed.add("action");
        }
        if (existing.patternType() != type) {
            changed.add("pattern_type");
        }
        if (!Objects.equals(existing.pattern(), pattern)) {
            changed.add("pattern");
        }
        if (existing.enabled() != enabled) {
            changed.add("enabled");
        }
        return List.copyOf(changed);
    }

    private static DlpPolicyView view(DlpPolicy policy) {
        return new DlpPolicyView(policy.id(), policy.name(), policy.action().name(),
                policy.patternType().name(), policy.pattern(), policy.enabled(),
                policy.createdAt(), policy.updatedAt());
    }
}
