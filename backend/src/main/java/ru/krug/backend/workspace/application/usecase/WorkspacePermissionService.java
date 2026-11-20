package ru.krug.backend.workspace.application.usecase;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.audit.application.model.AuditRecord;
import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;
import ru.krug.backend.workspace.application.command.WorkspacePermissionEntryCommand;
import ru.krug.backend.workspace.application.model.WorkspaceAccessContext;
import ru.krug.backend.workspace.application.model.WorkspacePermissionMatrixView;
import ru.krug.backend.workspace.application.model.WorkspaceRolePermissionsView;
import ru.krug.backend.workspace.domain.model.Membership;
import ru.krug.backend.workspace.domain.model.WorkspacePermission;
import ru.krug.backend.workspace.domain.repository.WorkspacePermissionRepository;

/**
 * {@code GET/PATCH /workspaces/{id}/permissions} (P0-4 / #82).
 *
 * <p>Every ACTIVE member may read the matrix (it describes their own effective rights).
 * PATCH requires {@code manage_permissions}. The OWNER row is immutable and always true;
 * an ADMIN may change MEMBER cells only, while an OWNER may also change ADMIN cells. This
 * prevents an ADMIN from widening its own role through the matrix.</p>
 */
@Service
public class WorkspacePermissionService {

    static final String ACTION = "workspace.permissions.updated";

    private final WorkspacePermissionGuard guard;
    private final WorkspacePermissionRepository permissions;
    private final AuditPort audit;
    private final ClockPort clock;

    public WorkspacePermissionService(WorkspacePermissionGuard guard,
                                      WorkspacePermissionRepository permissions,
                                      AuditPort audit, ClockPort clock) {
        this.guard = guard;
        this.permissions = permissions;
        this.audit = audit;
        this.clock = clock;
    }

    @Transactional
    public WorkspacePermissionMatrixView get(Principal principal, UUID workspaceId) {
        guard.requireMember(principal, workspaceId);
        permissions.insertDefaultsIfAbsent(workspaceId);
        return matrix(workspaceId);
    }

    @Transactional
    public WorkspacePermissionMatrixView update(Principal principal, UUID workspaceId,
                                                List<WorkspacePermissionEntryCommand> entries) {
        WorkspaceAccessContext context = guard.requirePermission(principal, workspaceId,
                WorkspacePermission.MANAGE_PERMISSIONS);
        if (entries == null || entries.isEmpty()) {
            throw DomainException.badRequest("At least one matrix entry is required",
                    Map.of("field", "entries"));
        }
        permissions.insertDefaultsIfAbsent(workspaceId);

        List<ValidatedEntry> validated = new ArrayList<>(entries.size());
        Set<String> seen = new HashSet<>();
        for (WorkspacePermissionEntryCommand entry : entries) {
            ValidatedEntry value = validate(context, entry);
            String key = value.role().name() + ":" + value.permission().apiName();
            if (!seen.add(key)) {
                throw DomainException.unprocessable(ErrorCode.VALIDATION_FAILED,
                        "Duplicate matrix entry", Map.of("field", "entries", "key", key));
            }
            validated.add(value);
        }
        for (ValidatedEntry value : validated) {
            permissions.update(workspaceId, value.role(), value.permission(), value.allowed());
        }

        List<Map<String, Object>> auditEntries = validated.stream()
                .map(value -> {
                    Map<String, Object> row = new LinkedHashMap<>();
                    row.put("role", value.role().name());
                    row.put("permission", value.permission().apiName());
                    row.put("allowed", value.allowed());
                    return row;
                })
                .toList();
        audit.append(new AuditRecord(workspaceId, principal.userId(), ACTION, "workspace",
                workspaceId, principal.requestId(), Map.of("entries", auditEntries),
                clock.now()));
        return matrix(workspaceId);
    }

    private static ValidatedEntry validate(WorkspaceAccessContext context,
                                           WorkspacePermissionEntryCommand entry) {
        if (entry == null) {
            throw DomainException.badRequest("A matrix entry must not be null",
                    Map.of("field", "entries"));
        }
        Membership.Role role;
        try {
            role = Membership.Role.valueOf(entry.role() == null ? "" : entry.role().strip());
        } catch (IllegalArgumentException ex) {
            throw DomainException.badRequest("Unknown workspace role",
                    Map.of("field", "role"));
        }
        if (role == Membership.Role.OWNER) {
            throw DomainException.unprocessable(ErrorCode.OWNER_PERMISSIONS_IMMUTABLE,
                    "OWNER permissions are immutable", Map.of("field", "role"));
        }
        if (role == Membership.Role.GUEST) {
            throw DomainException.badRequest("The matrix covers OWNER/ADMIN/MEMBER only",
                    Map.of("field", "role"));
        }
        if (context.role() != Membership.Role.OWNER && role == Membership.Role.ADMIN) {
            throw DomainException.forbidden(ErrorCode.PERMISSION_CHANGE_FORBIDDEN,
                    "Only the OWNER may change ADMIN permissions", Map.of("field", "role"));
        }
        WorkspacePermission permission = WorkspacePermission.parse(entry.permission())
                .orElseThrow(() -> DomainException.badRequest("Unknown permission",
                        Map.of("field", "permission")));
        return new ValidatedEntry(role, permission, entry.allowed());
    }

    private WorkspacePermissionMatrixView matrix(UUID workspaceId) {
        Map<Membership.Role, Map<WorkspacePermission, Boolean>> matrix =
                permissions.findMatrix(workspaceId);
        List<WorkspaceRolePermissionsView> roles = new ArrayList<>(3);
        for (Membership.Role role : List.of(Membership.Role.OWNER, Membership.Role.ADMIN,
                Membership.Role.MEMBER)) {
            Map<WorkspacePermission, Boolean> values = matrix.get(role);
            roles.add(new WorkspaceRolePermissionsView(role.name(),
                    allowed(values, WorkspacePermission.MANAGE_WORKSPACE),
                    allowed(values, WorkspacePermission.MANAGE_MEMBERS),
                    allowed(values, WorkspacePermission.MANAGE_INVITES),
                    allowed(values, WorkspacePermission.MANAGE_PERMISSIONS),
                    allowed(values, WorkspacePermission.VIEW_AUDIT),
                    allowed(values, WorkspacePermission.MANAGE_SECURITY)));
        }
        return new WorkspacePermissionMatrixView(workspaceId, List.copyOf(roles));
    }

    private static boolean allowed(Map<WorkspacePermission, Boolean> values,
                                   WorkspacePermission permission) {
        return values != null && Boolean.TRUE.equals(values.get(permission));
    }

    private record ValidatedEntry(Membership.Role role, WorkspacePermission permission,
                                  boolean allowed) {
    }
}
