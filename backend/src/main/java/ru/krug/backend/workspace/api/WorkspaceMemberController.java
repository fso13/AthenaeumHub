package ru.krug.backend.workspace.api;

import java.util.UUID;

import jakarta.validation.Valid;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.workspace.api.dto.AddWorkspaceMemberRequest;
import ru.krug.backend.workspace.api.dto.ChangeWorkspaceMemberRoleRequest;
import ru.krug.backend.workspace.api.dto.WorkspaceMemberPageResponse;
import ru.krug.backend.workspace.api.dto.WorkspaceMemberResponse;
import ru.krug.backend.workspace.api.mapper.WorkspaceApiMapper;
import ru.krug.backend.workspace.application.command.AddWorkspaceMemberCommand;
import ru.krug.backend.workspace.application.command.ChangeWorkspaceMemberRoleCommand;
import ru.krug.backend.workspace.application.usecase.AddWorkspaceMemberService;
import ru.krug.backend.workspace.application.usecase.ChangeWorkspaceMemberRoleService;
import ru.krug.backend.workspace.application.usecase.LeaveWorkspaceService;
import ru.krug.backend.workspace.application.usecase.ListWorkspaceMembersService;
import ru.krug.backend.workspace.application.usecase.RemoveWorkspaceMemberService;

/**
 * Workspace member directory and management (E10-B/E12-B).
 *
 * <pre>
 * GET    /workspaces/{workspaceId}/members              — active member directory
 * POST   /workspaces/{workspaceId}/members              — add an existing user by email
 * PATCH  /workspaces/{workspaceId}/members/{userId}     — change one role
 * DELETE /workspaces/{workspaceId}/members/{userId}     — soft-remove one member
 * DELETE /workspaces/{workspaceId}/members/me           — leave the workspace (self, #99)
 * </pre>
 *
 * <p>The controller stays thin: authorization (OWNER/ADMIN, owner/self protections), the
 * atomic member limit, audit and status mapping live in the application use cases and the
 * V27 SECURITY DEFINER functions.</p>
 */
@RestController
@RequestMapping("/api/v1/workspaces/{workspaceId}/members")
public class WorkspaceMemberController {

    private final ListWorkspaceMembersService members;
    private final AddWorkspaceMemberService addMember;
    private final ChangeWorkspaceMemberRoleService changeRole;
    private final RemoveWorkspaceMemberService removeMember;
    private final LeaveWorkspaceService leaveWorkspace;

    public WorkspaceMemberController(ListWorkspaceMembersService members,
                                     AddWorkspaceMemberService addMember,
                                     ChangeWorkspaceMemberRoleService changeRole,
                                     RemoveWorkspaceMemberService removeMember,
                                     LeaveWorkspaceService leaveWorkspace) {
        this.members = members;
        this.addMember = addMember;
        this.changeRole = changeRole;
        this.removeMember = removeMember;
        this.leaveWorkspace = leaveWorkspace;
    }

    @GetMapping
    public WorkspaceMemberPageResponse list(
            @PathVariable UUID workspaceId,
            @RequestParam(value = "query", required = false) String query,
            @RequestParam(value = "cursor", required = false) String cursor,
            @RequestParam(value = "limit", required = false) Integer limit,
            Principal principal) {
        return WorkspaceApiMapper.toResponse(
                members.list(principal, workspaceId, query, cursor, limit));
    }

    @PostMapping
    public ResponseEntity<WorkspaceMemberResponse> add(
            @PathVariable UUID workspaceId,
            @Valid @RequestBody AddWorkspaceMemberRequest request,
            Principal principal) {
        WorkspaceMemberResponse body = WorkspaceApiMapper.toResponse(addMember.add(principal,
                workspaceId, new AddWorkspaceMemberCommand(request.email(), request.role())));
        return ResponseEntity.status(201).body(body);
    }

    @PatchMapping("/{userId}")
    public WorkspaceMemberResponse changeRole(
            @PathVariable UUID workspaceId,
            @PathVariable UUID userId,
            @Valid @RequestBody ChangeWorkspaceMemberRoleRequest request,
            Principal principal) {
        return WorkspaceApiMapper.toResponse(changeRole.changeRole(principal, workspaceId,
                userId, new ChangeWorkspaceMemberRoleCommand(request.role())));
    }

    @DeleteMapping("/{userId}")
    public ResponseEntity<Void> remove(
            @PathVariable UUID workspaceId,
            @PathVariable UUID userId,
            Principal principal) {
        removeMember.remove(principal, workspaceId, userId);
        return ResponseEntity.noContent().build();
    }

    /**
     * Self-leave (#99). The literal {@code me} segment is more specific than the
     * {@code {userId}} template, so Spring routes it here instead of failing UUID
     * conversion. Idempotent: 204 even when the membership is already REMOVED.
     */
    @DeleteMapping("/me")
    public ResponseEntity<Void> leave(@PathVariable UUID workspaceId, Principal principal) {
        leaveWorkspace.leave(principal, workspaceId);
        return ResponseEntity.noContent().build();
    }
}
