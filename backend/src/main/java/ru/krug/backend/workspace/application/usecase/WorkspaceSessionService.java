package ru.krug.backend.workspace.application.usecase;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.audit.application.model.AuditRecord;
import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.auth.application.model.KeycloakSessionView;
import ru.krug.backend.auth.application.port.KeycloakAdminPort;
import ru.krug.backend.auth.application.port.ProviderUnavailableException;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;
import ru.krug.backend.workspace.application.model.WorkspaceSecurityCursor;
import ru.krug.backend.workspace.application.model.WorkspaceSessionPageView;
import ru.krug.backend.workspace.application.model.WorkspaceSessionRevokeAllView;
import ru.krug.backend.workspace.application.model.WorkspaceSessionView;
import ru.krug.backend.workspace.application.service.WorkspaceSecurityActions;
import ru.krug.backend.workspace.application.service.WorkspaceSecurityRequests;
import ru.krug.backend.workspace.domain.model.WorkspaceMemberIdentity;
import ru.krug.backend.workspace.domain.repository.WorkspaceSessionDirectory;

/**
 * {@code /workspaces/{id}/sessions} (P0-3): list and revoke Keycloak sessions of the
 * workspace's ACTIVE members. OWNER/ADMIN only.
 *
 * <p>There is no local session table: the authoritative list comes from the Keycloak Admin
 * API, addressed by the member's OIDC subject resolved through the V42
 * {@code security_member_subjects} function. Each session row exposes only the local user
 * id, a client-derived device label and timestamps; the Keycloak IP address and username
 * never cross the port. {@code current} marks the caller's own {@code sid}.</p>
 *
 * <p>A foreign or already-revoked session id is a {@code 404} with no side effect.
 * {@code revoke-all} spares the caller's current session so the administrator is not
 * logged out by their own action. A Keycloak outage is a {@code 503 AUTH_UNAVAILABLE}; the
 * operation is then best-effort and may have revoked some sessions before the failure.</p>
 */
@Service
public class WorkspaceSessionService {

    private static final String SESSION_TARGET = "session";
    private static final String SESSIONS_TARGET = "workspace_sessions";

    private final WorkspaceSecurityGuard guard;
    private final WorkspaceSessionDirectory directory;
    private final KeycloakAdminPort keycloak;
    private final AuditPort audit;
    private final ClockPort clock;

    public WorkspaceSessionService(WorkspaceSecurityGuard guard,
                                   WorkspaceSessionDirectory directory,
                                   KeycloakAdminPort keycloak, AuditPort audit,
                                   ClockPort clock) {
        this.guard = guard;
        this.directory = directory;
        this.keycloak = keycloak;
        this.audit = audit;
        this.clock = clock;
    }

    @Transactional(readOnly = true)
    public WorkspaceSessionPageView list(Principal principal, UUID workspaceId, String cursor,
                                         Integer requestedLimit) {
        guard.requireManager(principal, workspaceId);
        int limit = WorkspaceSecurityRequests.limit(requestedLimit,
                WorkspaceSecurityRequests.DEFAULT_SESSION_LIMIT);
        WorkspaceSecurityCursor decoded = WorkspaceSecurityRequests.cursor(cursor,
                WorkspaceSecurityCursor.SCOPE_SESSIONS, workspaceId);

        List<WorkspaceSessionView> rows = collect(principal, workspaceId);
        rows.sort(Comparator.comparing(WorkspaceSessionView::lastSeenAt).reversed()
                .thenComparing(WorkspaceSessionView::id, Comparator.reverseOrder()));
        if (decoded != null) {
            rows = rows.stream().filter(view -> afterCursor(view, decoded)).toList();
        }
        boolean hasMore = rows.size() > limit;
        List<WorkspaceSessionView> page = hasMore ? rows.subList(0, limit) : rows;

        String nextCursor = null;
        if (hasMore && !page.isEmpty()) {
            WorkspaceSessionView last = page.get(page.size() - 1);
            nextCursor = new WorkspaceSecurityCursor(WorkspaceSecurityCursor.SCOPE_SESSIONS,
                    workspaceId, last.lastSeenAt(), last.id()).encode();
        }
        return new WorkspaceSessionPageView(page, nextCursor, hasMore);
    }

    @Transactional
    public void revoke(Principal principal, UUID workspaceId, String rawSessionId) {
        guard.requireManager(principal, workspaceId);
        String sessionId = WorkspaceSecurityRequests.sessionId(rawSessionId);
        for (WorkspaceMemberIdentity member : members(principal, workspaceId)) {
            UUID keycloakUserId = keycloakUserId(member);
            if (keycloakUserId == null) {
                continue;
            }
            List<KeycloakSessionView> sessions = listSessions(keycloakUserId);
            boolean owned = sessions.stream()
                    .anyMatch(session -> sessionId.equals(session.id()));
            if (!owned) {
                continue;
            }
            revokeSession(keycloakUserId, sessionId);
            audit.append(new AuditRecord(workspaceId, principal.userId(),
                    WorkspaceSecurityActions.SESSION_REVOKED, SESSION_TARGET,
                    parseUuid(sessionId), principal.requestId(),
                    Map.of("target_user_id", member.userId().toString()), clock.now()));
            return;
        }
        // Foreign and already-revoked ids are deliberately indistinguishable.
        throw DomainException.notFound("Session not found");
    }

    @Transactional
    public WorkspaceSessionRevokeAllView revokeAll(Principal principal, UUID workspaceId) {
        guard.requireManager(principal, workspaceId);
        int revoked = 0;
        int affectedUsers = 0;
        for (WorkspaceMemberIdentity member : members(principal, workspaceId)) {
            UUID keycloakUserId = keycloakUserId(member);
            if (keycloakUserId == null) {
                continue;
            }
            List<KeycloakSessionView> sessions = listSessions(keycloakUserId);
            if (sessions.isEmpty()) {
                continue;
            }
            if (member.userId().equals(principal.userId())) {
                int revokedForCaller = 0;
                for (KeycloakSessionView session : sessions) {
                    if (principal.sessionId() != null
                            && principal.sessionId().equals(session.id())) {
                        continue;
                    }
                    revokeSession(keycloakUserId, session.id());
                    revokedForCaller++;
                }
                if (revokedForCaller > 0) {
                    revoked += revokedForCaller;
                    affectedUsers++;
                }
            } else {
                logoutAll(keycloakUserId);
                revoked += sessions.size();
                affectedUsers++;
            }
        }
        audit.append(new AuditRecord(workspaceId, principal.userId(),
                WorkspaceSecurityActions.SESSIONS_REVOKED_ALL, SESSIONS_TARGET, null,
                principal.requestId(),
                Map.of("revoked_sessions", revoked, "affected_users", affectedUsers),
                clock.now()));
        return new WorkspaceSessionRevokeAllView(revoked, affectedUsers);
    }

    private List<WorkspaceSessionView> collect(Principal principal, UUID workspaceId) {
        List<WorkspaceSessionView> rows = new ArrayList<>();
        for (WorkspaceMemberIdentity member : members(principal, workspaceId)) {
            UUID keycloakUserId = keycloakUserId(member);
            if (keycloakUserId == null) {
                continue;
            }
            for (KeycloakSessionView session : listSessions(keycloakUserId)) {
                if (session.id() == null || session.id().isBlank()
                        || session.lastAccessAt() == null) {
                    continue;
                }
                boolean current = member.userId().equals(principal.userId())
                        && principal.sessionId() != null
                        && principal.sessionId().equals(session.id());
                rows.add(new WorkspaceSessionView(session.id(), member.userId(),
                        session.name(), session.createdAt(), session.lastAccessAt(), current));
            }
        }
        return rows;
    }

    private List<WorkspaceMemberIdentity> members(Principal principal, UUID workspaceId) {
        return directory.findKeycloakMembers(workspaceId, principal.userId());
    }

    private List<KeycloakSessionView> listSessions(UUID keycloakUserId) {
        try {
            return keycloak.listSessions(keycloakUserId);
        } catch (ProviderUnavailableException ex) {
            throw authUnavailable();
        }
    }

    private void revokeSession(UUID keycloakUserId, String sessionId) {
        try {
            keycloak.revokeSession(keycloakUserId, sessionId);
        } catch (ProviderUnavailableException ex) {
            throw authUnavailable();
        }
    }

    private void logoutAll(UUID keycloakUserId) {
        try {
            keycloak.logoutAllSessions(keycloakUserId);
        } catch (ProviderUnavailableException ex) {
            throw authUnavailable();
        }
    }

    private static boolean afterCursor(WorkspaceSessionView view,
                                       WorkspaceSecurityCursor cursor) {
        int compared = view.lastSeenAt().compareTo(cursor.at());
        return compared < 0 || (compared == 0 && view.id().compareTo(cursor.key()) < 0);
    }

    private static UUID keycloakUserId(WorkspaceMemberIdentity member) {
        return parseUuid(member.keycloakSubject());
    }

    private static UUID parseUuid(String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        try {
            return UUID.fromString(value.strip());
        } catch (IllegalArgumentException ex) {
            return null;
        }
    }

    private static DomainException authUnavailable() {
        return DomainException.serviceUnavailable(ErrorCode.AUTH_UNAVAILABLE,
                "Authentication service is unavailable",
                Map.of("reason", "keycloak_unavailable"), 5L);
    }
}
