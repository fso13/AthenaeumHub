package ru.krug.backend.ops.application.usecase;

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
import ru.krug.backend.auth.application.usecase.PlatformAdminGuard;
import ru.krug.backend.ops.application.model.AdminSessionCursor;
import ru.krug.backend.ops.application.model.AdminSessionPageView;
import ru.krug.backend.ops.application.model.AdminSessionRevokeAllView;
import ru.krug.backend.ops.application.model.AdminSessionView;
import ru.krug.backend.ops.application.service.AdminPageRequests;
import ru.krug.backend.ops.domain.repository.AdminSessionDirectory;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * Platform-admin session management (#84).
 *
 * <pre>
 * GET    /admin/sessions?user_id=&amp;cursor=&amp;limit=
 * DELETE /admin/sessions/{sessionId}
 * POST   /admin/users/{userId}/revoke-sessions
 * </pre>
 *
 * <p>The local user id is resolved to its opaque Keycloak subject through the V49 function;
 * the raw IdP payload (IP address, username, client map) never crosses the port. Only the
 * session id, a client-derived device label and timestamps are returned. A missing identity
 * is {@code 404 USER_NOT_FOUND}; a Keycloak outage is {@code 503 AUTH_UNAVAILABLE}. Audit
 * rows store ids/counters only, never a session id, IP, username or token.</p>
 */
@Service
public class AdminSessionService {

    static final String ACTION_VIEWED = "admin.sessions.viewed";
    static final String ACTION_REVOKED = "admin.session.revoked";
    static final String ACTION_REVOKED_ALL = "admin.sessions.revoked_all";

    private static final String USER_TARGET = "user";
    private static final String SESSION_TARGET = "session";
    private static final int MAX_SESSION_ID_LENGTH = 128;

    private final PlatformAdminGuard adminGuard;
    private final AdminSessionDirectory directory;
    private final KeycloakAdminPort keycloak;
    private final AuditPort audit;
    private final ClockPort clock;

    public AdminSessionService(PlatformAdminGuard adminGuard, AdminSessionDirectory directory,
                               KeycloakAdminPort keycloak, AuditPort audit, ClockPort clock) {
        this.adminGuard = adminGuard;
        this.directory = directory;
        this.keycloak = keycloak;
        this.audit = audit;
        this.clock = clock;
    }

    @Transactional
    public AdminSessionPageView list(Principal principal, UUID userId, String cursor,
                                     Integer requestedLimit) {
        adminGuard.require(principal);
        if (userId == null) {
            throw DomainException.badRequest("user_id is required",
                    Map.of("field", "user_id"));
        }
        int limit = AdminPageRequests.limit(requestedLimit);
        AdminSessionCursor decoded = cursor == null || cursor.isBlank() ? null
                : AdminSessionCursor.decode(cursor, userId);
        UUID keycloakUserId = subject(userId, principal.userId());

        List<AdminSessionView> rows = listSessions(keycloakUserId).stream()
                .filter(session -> session.id() != null && !session.id().isBlank()
                        && session.lastAccessAt() != null)
                .map(session -> view(session, userId, principal))
                .sorted(Comparator.comparing(AdminSessionView::lastSeenAt).reversed()
                        .thenComparing(AdminSessionView::id, Comparator.reverseOrder()))
                .filter(view -> decoded == null || afterCursor(view, decoded))
                .toList();
        boolean hasMore = rows.size() > limit;
        List<AdminSessionView> page = hasMore ? rows.subList(0, limit) : rows;

        String nextCursor = null;
        if (hasMore && !page.isEmpty()) {
            AdminSessionView last = page.get(page.size() - 1);
            nextCursor = new AdminSessionCursor(AdminSessionCursor.SCOPE, userId,
                    last.lastSeenAt(), last.id()).encode();
        }
        audit.append(new AuditRecord(null, principal.userId(), ACTION_VIEWED, USER_TARGET,
                userId, principal.requestId(),
                Map.of("returned", page.size(), "has_more", hasMore), clock.now()));
        return new AdminSessionPageView(page, nextCursor, hasMore);
    }

    @Transactional
    public void revoke(Principal principal, String rawSessionId) {
        adminGuard.require(principal);
        String sessionId = sessionId(rawSessionId);
        revokeSession(sessionId);
        audit.append(new AuditRecord(null, principal.userId(), ACTION_REVOKED, SESSION_TARGET,
                parseUuid(sessionId), principal.requestId(), Map.of(), clock.now()));
    }

    @Transactional
    public AdminSessionRevokeAllView revokeAll(Principal principal, UUID userId) {
        adminGuard.require(principal);
        if (userId == null) {
            throw DomainException.badRequest("user_id is required",
                    Map.of("field", "user_id"));
        }
        UUID keycloakUserId = subject(userId, principal.userId());
        int sessions = listSessions(keycloakUserId).size();
        logoutAll(keycloakUserId);
        int affectedUsers = sessions == 0 ? 0 : 1;
        audit.append(new AuditRecord(null, principal.userId(), ACTION_REVOKED_ALL, USER_TARGET,
                userId, principal.requestId(),
                Map.of("revoked_sessions", sessions, "affected_users", affectedUsers),
                clock.now()));
        return new AdminSessionRevokeAllView(sessions, affectedUsers);
    }

    private UUID subject(UUID userId, UUID callerId) {
        String subject = directory.findKeycloakSubject(userId, callerId).orElse(null);
        UUID parsed = parseUuid(subject);
        if (parsed == null) {
            throw DomainException.notFound("User not found");
        }
        return parsed;
    }

    private List<KeycloakSessionView> listSessions(UUID keycloakUserId) {
        try {
            return keycloak.listSessions(keycloakUserId);
        } catch (ProviderUnavailableException ex) {
            throw authUnavailable();
        }
    }

    private void revokeSession(String sessionId) {
        try {
            keycloak.revokeSessionById(sessionId);
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

    private static AdminSessionView view(KeycloakSessionView session, UUID userId,
                                         Principal principal) {
        boolean current = userId.equals(principal.userId())
                && principal.sessionId() != null
                && principal.sessionId().equals(session.id());
        return new AdminSessionView(session.id(), userId, session.name(), session.createdAt(),
                session.lastAccessAt(), current);
    }

    private static boolean afterCursor(AdminSessionView view, AdminSessionCursor cursor) {
        int compared = view.lastSeenAt().compareTo(cursor.at());
        return compared < 0 || (compared == 0 && view.id().compareTo(cursor.sessionId()) < 0);
    }

    private static String sessionId(String raw) {
        if (raw == null) {
            throw DomainException.badRequest("sessionId is required",
                    Map.of("field", "sessionId"));
        }
        String value = raw.strip();
        if (value.isEmpty() || value.length() > MAX_SESSION_ID_LENGTH) {
            throw DomainException.badRequest(
                    "sessionId must be between 1 and " + MAX_SESSION_ID_LENGTH + " characters",
                    Map.of("field", "sessionId", "max", MAX_SESSION_ID_LENGTH));
        }
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            if (character < 0x20 || character == 0x7F) {
                throw DomainException.badRequest(
                        "sessionId must not contain control characters",
                        Map.of("field", "sessionId"));
            }
        }
        return value;
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
