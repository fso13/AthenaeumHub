package ru.krug.backend.workspace.application.usecase;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.audit.application.model.AuditRecord;
import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;
import ru.krug.backend.workspace.application.command.UpdateWorkspaceSecurityCommand;
import ru.krug.backend.workspace.application.model.WorkspaceSecurityContext;
import ru.krug.backend.workspace.application.model.WorkspaceSecurityView;
import ru.krug.backend.workspace.application.service.WorkspaceSecurityActions;
import ru.krug.backend.workspace.application.service.WorkspaceSecurityRequests;
import ru.krug.backend.workspace.domain.model.WorkspaceSecuritySettings;
import ru.krug.backend.workspace.domain.repository.WorkspaceSecuritySettingsRepository;

/**
 * {@code GET/PATCH /workspaces/{id}/security} (P0-3). OWNER/ADMIN only.
 *
 * <p>The workspace {@code security_mode} is immutable (V16 trigger) and is never part of
 * this surface: an explicit {@code security_mode} field is rejected with
 * {@code 422 MODE_CHANGE_FORBIDDEN} instead of being silently ignored. DLP can only be
 * enabled in a MANAGED workspace. Values are stored here for the security UI and for
 * downstream policy consumption; this slice does not add a new enforcement point in the
 * login or message pipeline.</p>
 */
@Service
public class WorkspaceSecuritySettingsService {

    private static final String TARGET_TYPE = "workspace_security";

    private final WorkspaceSecurityGuard guard;
    private final WorkspaceSecuritySettingsRepository settingsRepository;
    private final AuditPort audit;
    private final ClockPort clock;

    public WorkspaceSecuritySettingsService(WorkspaceSecurityGuard guard,
                                            WorkspaceSecuritySettingsRepository settingsRepository,
                                            AuditPort audit, ClockPort clock) {
        this.guard = guard;
        this.settingsRepository = settingsRepository;
        this.audit = audit;
        this.clock = clock;
    }

    @Transactional
    public WorkspaceSecurityView get(Principal principal, UUID workspaceId) {
        guard.requireManager(principal, workspaceId);
        return view(load(workspaceId));
    }

    @Transactional
    public WorkspaceSecurityView update(Principal principal, UUID workspaceId,
                                        UpdateWorkspaceSecurityCommand command) {
        WorkspaceSecurityContext context = guard.requireManager(principal, workspaceId);
        if (command == null || command.isEmpty()) {
            throw DomainException.badRequest("At least one field must be provided",
                    Map.of("field", "body"));
        }
        if (command.securityMode() != null) {
            throw DomainException.unprocessable(ErrorCode.MODE_CHANGE_FORBIDDEN,
                    "The workspace security mode is immutable",
                    Map.of("field", "security_mode", "security_mode", context.securityMode()));
        }

        WorkspaceSecuritySettings current = load(workspaceId);
        boolean requireTwoFactor = command.requireTwoFactor() == null
                ? current.requireTwoFactor() : command.requireTwoFactor();
        int sessionTimeout = command.sessionTimeoutMinutes() == null
                ? current.sessionTimeoutMinutes()
                : WorkspaceSecurityRequests.sessionTimeoutMinutes(
                        command.sessionTimeoutMinutes());
        boolean dlpEnabled = command.dlpEnabled() == null
                ? current.dlpEnabled() : command.dlpEnabled();
        int retentionDays = command.retentionDays() == null
                ? current.retentionDays()
                : WorkspaceSecurityRequests.retentionDays(command.retentionDays());
        if (dlpEnabled && context.e2ee()) {
            throw DomainException.unprocessable(ErrorCode.DLP_E2EE_UNSUPPORTED,
                    "DLP can only be enabled in a MANAGED workspace",
                    Map.of("field", "dlp_enabled", "security_mode", context.securityMode()));
        }

        List<String> changed = changed(current, requireTwoFactor, sessionTimeout, dlpEnabled,
                retentionDays);
        if (changed.isEmpty()) {
            return view(current);
        }
        WorkspaceSecuritySettings updated = current.with(requireTwoFactor, sessionTimeout,
                dlpEnabled, retentionDays, clock.now(), principal.userId());
        settingsRepository.update(updated);
        audit.append(new AuditRecord(workspaceId, principal.userId(),
                WorkspaceSecurityActions.SECURITY_UPDATED, TARGET_TYPE, null,
                principal.requestId(), Map.of("changed", changed), clock.now()));
        return view(updated);
    }

    private WorkspaceSecuritySettings load(UUID workspaceId) {
        settingsRepository.insertDefaultIfAbsent(workspaceId);
        return settingsRepository.find(workspaceId)
                .orElseThrow(() -> new IllegalStateException(
                        "workspace security settings disappeared after insert"));
    }

    private static List<String> changed(WorkspaceSecuritySettings current,
                                        boolean requireTwoFactor, int sessionTimeout,
                                        boolean dlpEnabled, int retentionDays) {
        List<String> changed = new ArrayList<>();
        if (current.requireTwoFactor() != requireTwoFactor) {
            changed.add("require_2fa");
        }
        if (current.sessionTimeoutMinutes() != sessionTimeout) {
            changed.add("session_timeout_minutes");
        }
        if (current.dlpEnabled() != dlpEnabled) {
            changed.add("dlp_enabled");
        }
        if (current.retentionDays() != retentionDays) {
            changed.add("retention_days");
        }
        return List.copyOf(changed);
    }

    private static WorkspaceSecurityView view(WorkspaceSecuritySettings settings) {
        return new WorkspaceSecurityView(settings.requireTwoFactor(),
                settings.sessionTimeoutMinutes(), settings.dlpEnabled(),
                settings.retentionDays(), settings.updatedAt());
    }
}
