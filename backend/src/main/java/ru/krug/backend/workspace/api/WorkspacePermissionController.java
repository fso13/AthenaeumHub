package ru.krug.backend.workspace.api;

import java.util.List;
import java.util.UUID;

import jakarta.validation.Valid;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.workspace.api.dto.UpdateWorkspacePermissionsRequest;
import ru.krug.backend.workspace.api.dto.WorkspacePermissionMatrixResponse;
import ru.krug.backend.workspace.api.dto.WorkspaceRolePermissionsResponse;
import ru.krug.backend.workspace.application.command.WorkspacePermissionEntryCommand;
import ru.krug.backend.workspace.application.model.WorkspacePermissionMatrixView;
import ru.krug.backend.workspace.application.usecase.WorkspacePermissionService;

/**
 * Workspace role matrix (P0-4 / #82). Readable by every active member; PATCH requires
 * {@code manage_permissions} and is further constrained for ADMIN callers.
 */
@RestController
@RequestMapping("/api/v1/workspaces/{workspaceId}/permissions")
public class WorkspacePermissionController {

    private final WorkspacePermissionService permissions;

    public WorkspacePermissionController(WorkspacePermissionService permissions) {
        this.permissions = permissions;
    }

    @GetMapping
    public WorkspacePermissionMatrixResponse get(@PathVariable UUID workspaceId,
                                                 Principal principal) {
        return toResponse(permissions.get(principal, workspaceId));
    }

    @PatchMapping
    public WorkspacePermissionMatrixResponse update(
            @PathVariable UUID workspaceId,
            @Valid @RequestBody UpdateWorkspacePermissionsRequest request,
            Principal principal) {
        List<WorkspacePermissionEntryCommand> entries = request.entries().stream()
                .map(entry -> new WorkspacePermissionEntryCommand(entry.role(),
                        entry.permission(), Boolean.TRUE.equals(entry.allowed())))
                .toList();
        return toResponse(permissions.update(principal, workspaceId, entries));
    }

    private static WorkspacePermissionMatrixResponse toResponse(
            WorkspacePermissionMatrixView view) {
        List<WorkspaceRolePermissionsResponse> roles = view.roles().stream()
                .map(role -> new WorkspaceRolePermissionsResponse(role.role(),
                        role.manageWorkspace(), role.manageMembers(), role.manageInvites(),
                        role.managePermissions(), role.viewAudit(), role.manageSecurity()))
                .toList();
        return new WorkspacePermissionMatrixResponse(view.workspaceId(), roles);
    }
}
