package ru.krug.backend.workspace.api;

import java.util.UUID;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.workspace.api.dto.WorkspaceSessionPageResponse;
import ru.krug.backend.workspace.api.dto.WorkspaceSessionRevokeAllResponse;
import ru.krug.backend.workspace.api.mapper.WorkspaceSecurityApiMapper;
import ru.krug.backend.workspace.application.usecase.WorkspaceSessionService;

/**
 * Workspace member session list/revoke (P0-3 / #81). OWNER/ADMIN only.
 *
 * <pre>
 * GET    /workspaces/{id}/sessions?cursor=&amp;limit=
 * DELETE /workspaces/{id}/sessions/{sessionId}
 * POST   /workspaces/{id}/sessions/revoke-all
 * </pre>
 *
 * <p>Sessions are the live Keycloak sessions of ACTIVE workspace members; the caller's own
 * {@code sid} is {@code current=true}. A foreign/already-revoked id is {@code 404}, and a
 * Keycloak outage is {@code 503 AUTH_UNAVAILABLE}. Revoke-all spares the caller's current
 * session.</p>
 */
@RestController
@RequestMapping("/api/v1/workspaces/{workspaceId}/sessions")
public class WorkspaceSessionController {

    private final WorkspaceSessionService sessions;

    public WorkspaceSessionController(WorkspaceSessionService sessions) {
        this.sessions = sessions;
    }

    @GetMapping
    public WorkspaceSessionPageResponse list(
            @PathVariable UUID workspaceId,
            @RequestParam(value = "cursor", required = false) String cursor,
            @RequestParam(value = "limit", required = false) Integer limit,
            Principal principal) {
        return WorkspaceSecurityApiMapper.toPage(
                sessions.list(principal, workspaceId, cursor, limit));
    }

    @DeleteMapping("/{sessionId}")
    public ResponseEntity<Void> revoke(@PathVariable UUID workspaceId,
                                       @PathVariable String sessionId,
                                       Principal principal) {
        sessions.revoke(principal, workspaceId, sessionId);
        return ResponseEntity.noContent().build();
    }

    @PostMapping("/revoke-all")
    public WorkspaceSessionRevokeAllResponse revokeAll(@PathVariable UUID workspaceId,
                                                       Principal principal) {
        return WorkspaceSecurityApiMapper.toResponse(
                sessions.revokeAll(principal, workspaceId));
    }
}
