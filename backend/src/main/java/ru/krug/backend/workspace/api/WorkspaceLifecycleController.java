package ru.krug.backend.workspace.api;

import java.util.UUID;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.workspace.application.usecase.DeleteWorkspaceService;

/**
 * Workspace lifecycle (#99).
 *
 * <pre>
 * DELETE /workspaces/{workspaceId} — OWNER soft-delete (idempotent 204)
 * </pre>
 *
 * <p>Self-leave lives in {@link WorkspaceMemberController} as
 * {@code DELETE /workspaces/{workspaceId}/members/me}. Both controllers are thin: the V55
 * SECURITY DEFINER function owns authorization and the write; the service maps outcomes and
 * appends the audit event.</p>
 */
@RestController
@RequestMapping("/api/v1/workspaces/{workspaceId}")
public class WorkspaceLifecycleController {

    private final DeleteWorkspaceService deleteWorkspace;

    public WorkspaceLifecycleController(DeleteWorkspaceService deleteWorkspace) {
        this.deleteWorkspace = deleteWorkspace;
    }

    @DeleteMapping
    public ResponseEntity<Void> delete(@PathVariable UUID workspaceId, Principal principal) {
        deleteWorkspace.delete(principal, workspaceId);
        return ResponseEntity.noContent().build();
    }
}
