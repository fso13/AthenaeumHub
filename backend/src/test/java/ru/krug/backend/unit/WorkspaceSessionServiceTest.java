package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import ru.krug.backend.audit.application.model.AuditRecord;
import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.auth.application.model.KeycloakSessionView;
import ru.krug.backend.auth.application.port.KeycloakAdminPort;
import ru.krug.backend.auth.application.port.ProviderUnavailableException;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.workspace.application.model.WorkspaceSecurityContext;
import ru.krug.backend.workspace.application.model.WorkspaceSessionPageView;
import ru.krug.backend.workspace.application.model.WorkspaceSessionRevokeAllView;
import ru.krug.backend.workspace.application.usecase.WorkspaceSecurityGuard;
import ru.krug.backend.workspace.application.usecase.WorkspaceSessionService;
import ru.krug.backend.workspace.domain.model.WorkspaceMemberIdentity;
import ru.krug.backend.workspace.domain.repository.WorkspaceSessionDirectory;

/** Keycloak session ownership/current/revoke-all decision table. */
class WorkspaceSessionServiceTest {

    private static final UUID WORKSPACE_ID = UUID.randomUUID();
    private static final UUID OWNER_ID = UUID.randomUUID();
    private static final UUID MEMBER_ID = UUID.randomUUID();
    private static final UUID KC_OWNER = UUID.randomUUID();
    private static final UUID KC_MEMBER = UUID.randomUUID();
    private static final String CURRENT_ID = "s-current";
    private static final String OLD_ID = "s-old";
    private static final String MEMBER_SESSION_ID = "s-member";
    private static final Instant NOW = Instant.parse("2026-11-20T10:00:00Z");

    private final WorkspaceSecurityGuard guard = mock(WorkspaceSecurityGuard.class);
    private final WorkspaceSessionDirectory directory = mock(WorkspaceSessionDirectory.class);
    private final KeycloakAdminPort keycloak = mock(KeycloakAdminPort.class);
    private final AuditPort audit = mock(AuditPort.class);
    private final ClockPort clock = mock(ClockPort.class);

    private WorkspaceSessionService service;
    private Principal owner;

    @BeforeEach
    void setUp() {
        service = new WorkspaceSessionService(guard, directory, keycloak, audit, clock);
        owner = new Principal(OWNER_ID, UUID.randomUUID(), WORKSPACE_ID, "req-1", CURRENT_ID);
        when(guard.requireManager(owner, WORKSPACE_ID))
                .thenReturn(new WorkspaceSecurityContext(WORKSPACE_ID, "MANAGED"));
        when(directory.findKeycloakMembers(WORKSPACE_ID, OWNER_ID)).thenReturn(List.of(
                new WorkspaceMemberIdentity(OWNER_ID, KC_OWNER.toString()),
                new WorkspaceMemberIdentity(MEMBER_ID, KC_MEMBER.toString())));
        when(clock.now()).thenReturn(NOW);
    }

    @Test
    void listMarksCurrentAndSortsByLastSeen() {
        when(keycloak.listSessions(KC_OWNER)).thenReturn(List.of(
                session(CURRENT_ID, "Krug Web", NOW.minusSeconds(60)),
                session(OLD_ID, "Old Browser", NOW.minusSeconds(3600))));
        when(keycloak.listSessions(KC_MEMBER)).thenReturn(List.of(
                session(MEMBER_SESSION_ID, "Member Web", NOW.minusSeconds(10))));

        WorkspaceSessionPageView page = service.list(owner, WORKSPACE_ID, null, 10);

        assertThat(page.items()).extracting(view -> view.id())
                .containsExactly(MEMBER_SESSION_ID, CURRENT_ID, OLD_ID);
        assertThat(page.items()).extracting(view -> view.current())
                .containsExactly(false, true, false);
        assertThat(page.items()).extracting(view -> view.userId())
                .containsExactly(MEMBER_ID, OWNER_ID, OWNER_ID);
        assertThat(page.items().get(1).device()).isEqualTo("Krug Web");
        assertThat(page.hasMore()).isFalse();
    }

    @Test
    void listPaginatesWithAnOpaqueCursor() {
        when(keycloak.listSessions(KC_OWNER)).thenReturn(List.of(
                session(CURRENT_ID, "Krug Web", NOW.minusSeconds(60)),
                session(OLD_ID, "Old Browser", NOW.minusSeconds(3600))));
        when(keycloak.listSessions(KC_MEMBER)).thenReturn(List.of(
                session(MEMBER_SESSION_ID, "Member Web", NOW.minusSeconds(10))));

        WorkspaceSessionPageView first = service.list(owner, WORKSPACE_ID, null, 1);
        assertThat(first.items()).hasSize(1);
        assertThat(first.hasMore()).isTrue();
        assertThat(first.nextCursor()).isNotBlank();

        WorkspaceSessionPageView second = service.list(owner, WORKSPACE_ID,
                first.nextCursor(), 1);
        assertThat(second.items()).hasSize(1);
        assertThat(second.items().get(0).id()).isEqualTo(CURRENT_ID);
    }

    @Test
    void revokeForeignSessionIs404WithoutAWrite() {
        when(keycloak.listSessions(any())).thenReturn(List.of(
                session(CURRENT_ID, "Krug Web", NOW)));

        assertThatThrownBy(() -> service.revoke(owner, WORKSPACE_ID, "s-foreign"))
                .isInstanceOfSatisfying(DomainException.class, ex ->
                        assertThat(ex.code()).isEqualTo("NOT_FOUND"));

        verify(keycloak, never()).revokeSession(any(), any());
        verify(audit, never()).append(any());
    }

    @Test
    void revokeMemberSessionUsesTheOwnersKeycloakSubjectAndAuditsTheMemberId() {
        when(keycloak.listSessions(KC_OWNER)).thenReturn(List.of());
        when(keycloak.listSessions(KC_MEMBER)).thenReturn(List.of(
                session(MEMBER_SESSION_ID, "Member Web", NOW)));

        service.revoke(owner, WORKSPACE_ID, MEMBER_SESSION_ID);

        verify(keycloak).revokeSession(KC_MEMBER, MEMBER_SESSION_ID);
        ArgumentCaptor<AuditRecord> record = ArgumentCaptor.forClass(AuditRecord.class);
        verify(audit).append(record.capture());
        assertThat(record.getValue().action()).isEqualTo("workspace.session.revoked");
        assertThat(record.getValue().workspaceId()).isEqualTo(WORKSPACE_ID);
        assertThat(record.getValue().metadata())
                .containsEntry("target_user_id", MEMBER_ID.toString())
                .doesNotContainKeys("session_id", "ip", "email");
    }

    @Test
    void keycloakOutageIsA503() {
        when(keycloak.listSessions(KC_OWNER)).thenThrow(new ProviderUnavailableException());

        assertThatThrownBy(() -> service.list(owner, WORKSPACE_ID, null, 10))
                .isInstanceOfSatisfying(DomainException.class, ex -> {
                    assertThat(ex.code()).isEqualTo("AUTH_UNAVAILABLE");
                    assertThat(ex.retryAfterSeconds()).isEqualTo(5L);
                });
    }

    @Test
    void revokeAllSparesTheCallerCurrentSessionAndUsesLogoutForOthers() {
        when(keycloak.listSessions(KC_OWNER)).thenReturn(List.of(
                session(CURRENT_ID, "Krug Web", NOW.minusSeconds(60)),
                session(OLD_ID, "Old Browser", NOW.minusSeconds(3600))));
        when(keycloak.listSessions(KC_MEMBER)).thenReturn(List.of(
                session(MEMBER_SESSION_ID, "Member Web", NOW.minusSeconds(10))));

        WorkspaceSessionRevokeAllView result = service.revokeAll(owner, WORKSPACE_ID);

        assertThat(result.revokedSessions()).isEqualTo(2);
        assertThat(result.affectedUsers()).isEqualTo(2);
        verify(keycloak).revokeSession(KC_OWNER, OLD_ID);
        verify(keycloak, never()).revokeSession(KC_OWNER, CURRENT_ID);
        verify(keycloak, never()).logoutAllSessions(KC_OWNER);
        verify(keycloak).logoutAllSessions(KC_MEMBER);

        ArgumentCaptor<AuditRecord> record = ArgumentCaptor.forClass(AuditRecord.class);
        verify(audit).append(record.capture());
        assertThat(record.getValue().action()).isEqualTo("workspace.sessions.revoked_all");
        assertThat(record.getValue().metadata())
                .containsEntry("revoked_sessions", 2)
                .containsEntry("affected_users", 2);
    }

    @Test
    void aMalformedKeycloakSubjectIsSkippedWithoutACall() {
        when(directory.findKeycloakMembers(WORKSPACE_ID, OWNER_ID)).thenReturn(List.of(
                new WorkspaceMemberIdentity(OWNER_ID, "not-a-uuid")));

        WorkspaceSessionPageView page = service.list(owner, WORKSPACE_ID, null, 10);

        assertThat(page.items()).isEmpty();
        verify(keycloak, never()).listSessions(any());
    }

    private static KeycloakSessionView session(String id, String name, Instant lastAccess) {
        return new KeycloakSessionView(id, name, lastAccess.minusSeconds(600), lastAccess);
    }
}
