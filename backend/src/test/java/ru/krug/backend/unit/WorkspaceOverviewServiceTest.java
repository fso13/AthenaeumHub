package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.TenantContext;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.workspace.application.port.WorkspacePresencePort;
import ru.krug.backend.workspace.application.usecase.WorkspaceOverviewService;
import ru.krug.backend.workspace.domain.model.Membership;
import ru.krug.backend.workspace.domain.model.Workspace;
import ru.krug.backend.workspace.domain.model.WorkspaceAuditEvent;
import ru.krug.backend.workspace.domain.model.WorkspaceOverviewStats;
import ru.krug.backend.workspace.domain.repository.WorkspaceAuditRepository;
import ru.krug.backend.workspace.domain.repository.WorkspaceOverviewRepository;
import ru.krug.backend.workspace.domain.repository.WorkspaceRepository;

/** Overview authorization and manager-only audit preview. */
class WorkspaceOverviewServiceTest {

    private static final UUID WORKSPACE_ID = UUID.randomUUID();
    private static final UUID USER_ID = UUID.randomUUID();
    private static final UUID CHAT_ID = UUID.randomUUID();
    private static final Instant NOW = Instant.parse("2026-11-20T10:00:00Z");

    private final TenantContext tenantContext = mock(TenantContext.class);
    private final WorkspaceRepository workspaces = mock(WorkspaceRepository.class);
    private final WorkspaceOverviewRepository overviews = mock(WorkspaceOverviewRepository.class);
    private final WorkspaceAuditRepository audits = mock(WorkspaceAuditRepository.class);
    private final WorkspacePresencePort presence = mock(WorkspacePresencePort.class);
    private final ClockPort clock = mock(ClockPort.class);

    private WorkspaceOverviewService service;
    private Principal principal;

    @BeforeEach
    void setUp() {
        service = new WorkspaceOverviewService(tenantContext, workspaces, overviews, audits,
                presence, clock);
        principal = new Principal(USER_ID, UUID.randomUUID(), null, "request");
        when(clock.now()).thenReturn(NOW);
        when(workspaces.findById(WORKSPACE_ID)).thenReturn(Optional.of(workspace()));
        when(overviews.stats(eq(WORKSPACE_ID), eq(USER_ID), eq(NOW)))
                .thenReturn(Optional.of(stats()));
    }

    @Test
    void managerGetsTheBoundedAuditPreviewAndClampedPresence() {
        when(workspaces.findMembership(WORKSPACE_ID, USER_ID))
                .thenReturn(Optional.of(membership(Membership.Role.OWNER)));
        when(presence.onlineMemberCount(WORKSPACE_ID)).thenReturn(9);
        when(audits.page(eq(WORKSPACE_ID), eq(USER_ID), isNull(), isNull(), isNull(), isNull(),
                isNull(), isNull(), eq(5)))
                .thenReturn(List.of(new WorkspaceAuditEvent(UUID.randomUUID(),
                        "workspace.security.updated", USER_ID, "workspace", null, NOW)));

        var view = service.overview(principal, WORKSPACE_ID);

        assertThat(view.membersTotal()).isEqualTo(3);
        assertThat(view.membersOnline()).isEqualTo(3);
        assertThat(view.auditRecent()).hasSize(1);
        assertThat(view.auditRecent().get(0).action()).isEqualTo("workspace.security.updated");
        assertThat(view.generatedAt()).isEqualTo(NOW);
        verify(tenantContext).activate(principal.withWorkspace(WORKSPACE_ID));
    }

    @Test
    void regularMemberGetsNoAuditPreview() {
        when(workspaces.findMembership(WORKSPACE_ID, USER_ID))
                .thenReturn(Optional.of(membership(Membership.Role.MEMBER)));
        when(presence.onlineMemberCount(WORKSPACE_ID)).thenReturn(0);

        var view = service.overview(principal, WORKSPACE_ID);

        assertThat(view.auditRecent()).isEmpty();
        verify(audits, never()).page(any(), any(), any(), any(), any(), any(), any(), any(),
                any(Integer.class));
    }

    @Test
    void nonMemberIsForbidden() {
        when(workspaces.findMembership(WORKSPACE_ID, USER_ID)).thenReturn(Optional.empty());
        assertThatThrownBy(() -> service.overview(principal, WORKSPACE_ID))
                .isInstanceOf(DomainException.class)
                .satisfies(ex -> assertThat(((DomainException) ex).category().name())
                        .isEqualTo("FORBIDDEN"));
    }

    @Test
    void missingWorkspaceIsForbiddenWithoutStatsRead() {
        when(workspaces.findById(WORKSPACE_ID)).thenReturn(Optional.empty());
        assertThatThrownBy(() -> service.overview(principal, WORKSPACE_ID))
                .isInstanceOf(DomainException.class);
        verify(overviews, never()).stats(any(), any(), any());
    }

    private Workspace workspace() {
        return Workspace.reconstitute(WORKSPACE_ID, "Overview", "overview",
                Workspace.SecurityMode.MANAGED, Workspace.Status.ACTIVE, USER_ID);
    }

    private Membership membership(Membership.Role role) {
        return Membership.reconstitute(WORKSPACE_ID, USER_ID, role, Membership.Status.ACTIVE);
    }

    private WorkspaceOverviewStats stats() {
        return new WorkspaceOverviewStats(3, 4, 10, 2, 1, 4096, 128, 1048576, 1);
    }
}
