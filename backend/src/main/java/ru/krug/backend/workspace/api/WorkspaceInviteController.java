package ru.krug.backend.workspace.api;

import java.util.UUID;

import jakarta.validation.Valid;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.workspace.api.dto.WorkspaceInviteAcceptanceResponse;
import ru.krug.backend.workspace.api.dto.WorkspaceInviteCreateRequest;
import ru.krug.backend.workspace.api.dto.WorkspaceInviteCreatedResponse;
import ru.krug.backend.workspace.api.dto.WorkspaceInviteListResponse;
import ru.krug.backend.workspace.api.mapper.WorkspaceApiMapper;
import ru.krug.backend.workspace.application.command.WorkspaceInviteCreateCommand;
import ru.krug.backend.workspace.application.usecase.WorkspaceInviteService;

/**
 * Workspace invite links (P0-4 / #82).
 *
 * <pre>
 * GET    /workspaces/{id}/invites                — metadata only (manage_invites)
 * POST   /workspaces/{id}/invites                — create; raw token returned once
 * DELETE /workspaces/{id}/invites/{inviteId}     — revoke (idempotent)
 * POST   /workspace-invites/{token}/accept       — join with the invite role
 * </pre>
 *
 * <p>No email is sent by the backend: the creating OWNER/ADMIN receives the token/accept
 * URL and shares it out of band. No raw token or hash ever appears in list responses,
 * audit or logs.</p>
 */
@RestController
@RequestMapping("/api/v1")
public class WorkspaceInviteController {

    private final WorkspaceInviteService invites;

    public WorkspaceInviteController(WorkspaceInviteService invites) {
        this.invites = invites;
    }

    @GetMapping("/workspaces/{workspaceId}/invites")
    public WorkspaceInviteListResponse list(@PathVariable UUID workspaceId,
                                            Principal principal) {
        return WorkspaceApiMapper.toResponse(invites.list(principal, workspaceId));
    }

    @PostMapping("/workspaces/{workspaceId}/invites")
    public ResponseEntity<WorkspaceInviteCreatedResponse> create(
            @PathVariable UUID workspaceId,
            @Valid @RequestBody(required = false) WorkspaceInviteCreateRequest request,
            Principal principal) {
        WorkspaceInviteCreateCommand command = request == null
                ? new WorkspaceInviteCreateCommand(null, null, null)
                : new WorkspaceInviteCreateCommand(request.role(), request.maxUses(),
                        request.expiresInSeconds());
        return ResponseEntity.status(201)
                .body(WorkspaceApiMapper.toResponse(
                        invites.create(principal, workspaceId, command)));
    }

    @DeleteMapping("/workspaces/{workspaceId}/invites/{inviteId}")
    public ResponseEntity<Void> revoke(@PathVariable UUID workspaceId,
                                       @PathVariable UUID inviteId,
                                       Principal principal) {
        invites.revoke(principal, workspaceId, inviteId);
        return ResponseEntity.noContent().build();
    }

    @PostMapping("/workspace-invites/{token}/accept")
    public WorkspaceInviteAcceptanceResponse accept(@PathVariable String token,
                                                    Principal principal) {
        return WorkspaceApiMapper.toResponse(invites.accept(principal, token));
    }
}
