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
import ru.krug.backend.shared.application.port.TenantContext;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.workspace.application.command.UpdateWorkspaceSettingsCommand;
import ru.krug.backend.workspace.application.model.WorkspaceAccessContext;
import ru.krug.backend.workspace.application.model.WorkspaceSummaryView;
import ru.krug.backend.workspace.application.port.WorkspaceLogoPort;
import ru.krug.backend.workspace.domain.model.Workspace;
import ru.krug.backend.workspace.domain.model.WorkspacePermission;
import ru.krug.backend.workspace.domain.repository.WorkspaceRepository;

/**
 * {@code PATCH /workspaces/{id}} and {@code POST/DELETE /workspaces/{id}/avatar}
 * (P0-4 / #82). Requires {@code manage_workspace}; OWNER always has it.
 *
 * <p>There is no new upload endpoint: the logo body references an existing managed
 * attachment in the same workspace that must be a CLEAN image. The audit event records
 * changed field names only; names/descriptions/logo ids never enter the chain.</p>
 */
@Service
public class WorkspaceSettingsService {

    static final String ACTION = "workspace.updated";

    private final WorkspacePermissionGuard guard;
    private final WorkspaceRepository workspaces;
    private final WorkspaceLogoPort logos;
    private final TenantContext tenantContext;
    private final AuditPort audit;
    private final ClockPort clock;

    public WorkspaceSettingsService(WorkspacePermissionGuard guard,
                                    WorkspaceRepository workspaces, WorkspaceLogoPort logos,
                                    TenantContext tenantContext, AuditPort audit,
                                    ClockPort clock) {
        this.guard = guard;
        this.workspaces = workspaces;
        this.logos = logos;
        this.tenantContext = tenantContext;
        this.audit = audit;
        this.clock = clock;
    }

    @Transactional
    public WorkspaceSummaryView update(Principal principal, UUID workspaceId,
                                       UpdateWorkspaceSettingsCommand command) {
        if (command == null || command.isEmpty()) {
            throw DomainException.badRequest("At least one field must be provided",
                    Map.of("field", "body"));
        }
        WorkspaceAccessContext context = guard.requirePermission(principal, workspaceId,
                WorkspacePermission.MANAGE_WORKSPACE);
        Workspace workspace = context.workspace();

        String name = command.namePresent() ? requireName(command.name()) : null;
        String description = command.descriptionPresent()
                ? requireDescription(command.description()) : null;
        UUID logoFileId = null;
        if (command.logoPresent() && command.logoFileId() != null) {
            logoFileId = logos.requireLogo(workspaceId, command.logoFileId());
            // The file port activates the narrow file-resolve role; restore the tenant GUC
            // before writing the workspace row and the audit chain.
            tenantContext.activate(principal.withWorkspace(workspaceId));
        }

        Workspace updated;
        try {
            updated = workspace.withSettings(name, description, command.descriptionPresent(),
                    logoFileId, command.logoPresent());
        } catch (IllegalArgumentException ex) {
            throw DomainException.badRequest(ex.getMessage(),
                    Map.of("field", "settings"));
        }
        workspaces.updateDetails(workspaceId, updated.name(), updated.description(),
                updated.logoFileId());

        List<String> changed = changedFields(workspace, updated, command);
        if (!changed.isEmpty()) {
            audit.append(new AuditRecord(workspaceId, principal.userId(), ACTION, "workspace",
                    workspaceId, principal.requestId(), Map.of("fields", changed),
                    clock.now()));
        }
        return new WorkspaceSummaryView(updated.id(), updated.name(), updated.slug(),
                context.role().name(), updated.securityMode().name(), updated.description(),
                updated.logoFileId());
    }

    @Transactional
    public WorkspaceSummaryView setLogo(Principal principal, UUID workspaceId, UUID fileId) {
        return update(principal, workspaceId,
                new UpdateWorkspaceSettingsCommand(false, null, false, null, true, fileId));
    }

    @Transactional
    public WorkspaceSummaryView removeLogo(Principal principal, UUID workspaceId) {
        return update(principal, workspaceId,
                new UpdateWorkspaceSettingsCommand(false, null, false, null, true, null));
    }

    private static List<String> changedFields(Workspace before, Workspace after,
                                              UpdateWorkspaceSettingsCommand command) {
        List<String> changed = new ArrayList<>(3);
        if (command.namePresent() && !before.name().equals(after.name())) {
            changed.add("name");
        }
        if (command.descriptionPresent()
                && !java.util.Objects.equals(before.description(), after.description())) {
            changed.add("description");
        }
        if (command.logoPresent()
                && !java.util.Objects.equals(before.logoFileId(), after.logoFileId())) {
            changed.add("logo_file_id");
        }
        return List.copyOf(changed);
    }

    private static String requireName(String value) {
        String normalized = value == null ? null : value.strip();
        if (normalized == null || normalized.isEmpty()) {
            throw DomainException.badRequest("name must not be blank",
                    Map.of("field", "name"));
        }
        if (normalized.length() > 120) {
            throw DomainException.badRequest("name must be at most 120 characters",
                    Map.of("field", "name"));
        }
        return normalized;
    }

    private static String requireDescription(String value) {
        String normalized = value == null ? null : value.strip();
        if (normalized == null || normalized.isEmpty()) {
            return null;
        }
        if (normalized.length() > Workspace.MAX_DESCRIPTION) {
            throw DomainException.badRequest("description must be at most 500 characters",
                    Map.of("field", "description"));
        }
        for (int index = 0; index < normalized.length(); index++) {
            char character = normalized.charAt(index);
            if (Character.isISOControl(character) && character != '\n' && character != '\r'
                    && character != '\t') {
                throw DomainException.badRequest(
                        "description contains a control character",
                        Map.of("field", "description"));
            }
        }
        return normalized;
    }
}
