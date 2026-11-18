package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import java.time.Instant;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import ru.krug.backend.audit.application.model.AuditRecord;
import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.auth.application.model.KeycloakUserView;
import ru.krug.backend.auth.application.model.UserProfileView;
import ru.krug.backend.auth.application.port.KeycloakAdminPort;
import ru.krug.backend.auth.application.port.ProviderUnavailableException;
import ru.krug.backend.auth.application.service.DeviceKeyEvents;
import ru.krug.backend.auth.application.usecase.PlatformAdminGuard;
import ru.krug.backend.ops.application.usecase.ChangeUserStatusService;
import ru.krug.backend.ops.domain.model.AdminUserDetailRow;
import ru.krug.backend.ops.domain.model.AdminUserStatusChange;
import ru.krug.backend.ops.domain.repository.AdminActionRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.error.DomainException;

/**
 * Unit-level decision table for suspend/activate: self-suspend, last-admin conflict, already
 * suspended, Keycloak disable + logout order and the 503 rollback signal. The end-to-end
 * behaviour is covered by {@code AdminActionsIT}.
 */
class ChangeUserStatusServiceTest {

    private static final UUID ADMIN_ID = UUID.randomUUID();
    private static final UUID TARGET_ID = UUID.randomUUID();
    private static final UUID KEYCLOAK_ID = UUID.randomUUID();
    private static final String TARGET_EMAIL = "target@example.test";

    private final PlatformAdminGuard guard = mock(PlatformAdminGuard.class);
    private final AdminActionRepository actions = mock(AdminActionRepository.class);
    private final KeycloakAdminPort keycloak = mock(KeycloakAdminPort.class);
    private final AuditPort audit = mock(AuditPort.class);
    private final DeviceKeyEvents events = mock(DeviceKeyEvents.class);
    private final ClockPort clock = mock(ClockPort.class);

    private ChangeUserStatusService service;
    private Principal admin;

    @BeforeEach
    void setUp() {
        service = new ChangeUserStatusService(guard, actions, keycloak, audit, events, clock);
        admin = new Principal(ADMIN_ID, null, null, "req-e11");
        when(guard.require(admin)).thenReturn(new UserProfileView(ADMIN_ID.toString(),
                "Admin", "admin@example.test", true));
        when(clock.now()).thenReturn(Instant.parse("2026-11-18T09:00:00Z"));
    }

    @Test
    void selfSuspendIsRejectedBeforeAnyReadOrSideEffect() {
        assertThatThrownBy(() -> service.suspend(admin, ADMIN_ID))
                .isInstanceOfSatisfying(DomainException.class, ex ->
                        assertThat(ex.code()).isEqualTo("SELF_ACTION_FORBIDDEN"));

        verifyNoInteractions(actions, keycloak, audit, events);
    }

    @Test
    void lastAdminOutcomeIsAConflictAndDoesNotTouchKeycloakOrAudit() {
        when(actions.findUser(TARGET_ID)).thenReturn(Optional.of(
                new AdminUserDetailRow(TARGET_ID, TARGET_EMAIL, "Target", "ACTIVE", true)));
        when(actions.setUserStatus(TARGET_ID, "SUSPENDED")).thenReturn(
                new AdminUserStatusChange(AdminUserStatusChange.Outcome.LAST_ADMIN, TARGET_ID,
                        "ACTIVE"));

        assertThatThrownBy(() -> service.suspend(admin, TARGET_ID))
                .isInstanceOfSatisfying(DomainException.class, ex ->
                        assertThat(ex.code()).isEqualTo("LAST_PLATFORM_ADMIN"));

        verifyNoInteractions(keycloak, audit, events);
    }

    @Test
    void alreadySuspendedIsAConflictWithoutAWrite() {
        when(actions.findUser(TARGET_ID)).thenReturn(Optional.of(
                new AdminUserDetailRow(TARGET_ID, TARGET_EMAIL, "Target", "SUSPENDED", false)));

        assertThatThrownBy(() -> service.suspend(admin, TARGET_ID))
                .isInstanceOfSatisfying(DomainException.class, ex ->
                        assertThat(ex.code()).isEqualTo("USER_ALREADY_SUSPENDED"));

        verify(actions, never()).setUserStatus(any(), anyString());
        verifyNoInteractions(keycloak, audit, events);
    }

    @Test
    void suspendDisablesKeycloakLogsOutAppendsAuditAndRevokesWsSessions() {
        when(actions.findUser(TARGET_ID)).thenReturn(Optional.of(
                new AdminUserDetailRow(TARGET_ID, TARGET_EMAIL, "Target", "ACTIVE", false)));
        when(actions.setUserStatus(TARGET_ID, "SUSPENDED")).thenReturn(
                new AdminUserStatusChange(AdminUserStatusChange.Outcome.OK, TARGET_ID,
                        "SUSPENDED"));
        when(keycloak.findByEmail(TARGET_EMAIL)).thenReturn(Optional.of(
                new KeycloakUserView(KEYCLOAK_ID, TARGET_EMAIL, TARGET_EMAIL, "Target", true,
                        true)));

        service.suspend(admin, TARGET_ID);

        verify(keycloak).setEnabled(KEYCLOAK_ID, false);
        verify(keycloak).logoutAllSessions(KEYCLOAK_ID);

        ArgumentCaptor<AuditRecord> record = ArgumentCaptor.forClass(AuditRecord.class);
        verify(audit).append(record.capture());
        assertThat(record.getValue().action()).isEqualTo("admin.user.suspended");
        assertThat(record.getValue().targetId()).isEqualTo(TARGET_ID);
        assertThat(record.getValue().metadata())
                .containsEntry("previous_status", "ACTIVE")
                .containsEntry("status", "SUSPENDED")
                .isEqualTo(Map.of("previous_status", "ACTIVE", "status", "SUSPENDED"));

        verify(events).userSessionsRevoked(TARGET_ID, "USER_SUSPENDED");
    }

    @Test
    void unreachableKeycloakIs503AndNothingIsAudited() {
        when(actions.findUser(TARGET_ID)).thenReturn(Optional.of(
                new AdminUserDetailRow(TARGET_ID, TARGET_EMAIL, "Target", "ACTIVE", false)));
        when(actions.setUserStatus(TARGET_ID, "SUSPENDED")).thenReturn(
                new AdminUserStatusChange(AdminUserStatusChange.Outcome.OK, TARGET_ID,
                        "SUSPENDED"));
        when(keycloak.findByEmail(TARGET_EMAIL)).thenThrow(new ProviderUnavailableException());

        assertThatThrownBy(() -> service.suspend(admin, TARGET_ID))
                .isInstanceOfSatisfying(DomainException.class, ex -> {
                    assertThat(ex.code()).isEqualTo("AUTH_UNAVAILABLE");
                    assertThat(ex.retryAfterSeconds()).isEqualTo(5L);
                });

        verify(audit, never()).append(any());
        verify(events, never()).userSessionsRevoked(any(), anyString());
    }
}
