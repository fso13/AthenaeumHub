package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;

import java.time.Instant;
import java.util.UUID;

import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import ru.krug.backend.audit.application.model.AuditRecord;
import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.chat.application.command.DefaultChatCommand;
import ru.krug.backend.chat.application.port.ChatProvisioningPort;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.TenantContext;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.workspace.application.command.CreateWorkspaceCommand;
import ru.krug.backend.workspace.application.model.WorkspaceSummaryView;
import ru.krug.backend.workspace.application.service.WorkspaceSlugFactory;
import ru.krug.backend.workspace.application.usecase.WorkspaceOnboardingService;
import ru.krug.backend.workspace.domain.model.Membership;
import ru.krug.backend.workspace.domain.model.Workspace;
import ru.krug.backend.workspace.domain.repository.WorkspaceRepository;

class WorkspaceOnboardingServiceTest {

    @Test
    void createsWorkspaceOwnerAndDefaultChatAndAudits() {
        TenantContext tenant = mock(TenantContext.class);
        WorkspaceRepository repository = mock(WorkspaceRepository.class);
        ChatProvisioningPort chat = mock(ChatProvisioningPort.class);
        AuditPort audit = mock(AuditPort.class);
        UUID userId = UUID.randomUUID();
        Principal principal = new Principal(userId, null, null, "req-1");
        WorkspaceOnboardingService service = new WorkspaceOnboardingService(tenant, repository,
                chat, new WorkspaceSlugFactory(), audit, () -> Instant.parse("2026-01-01T00:00:00Z"));

        WorkspaceSummaryView view = service.create(principal,
                new CreateWorkspaceCommand("Моя команда", "E2EE"));

        assertThat(view.role()).isEqualTo("OWNER");
        assertThat(view.securityMode()).isEqualTo("E2EE");
        assertThat(view.slug()).startsWith("moya-komanda-");

        ArgumentCaptor<Workspace> workspaceCaptor = ArgumentCaptor.forClass(Workspace.class);
        verify(repository).save(workspaceCaptor.capture());
        assertThat(workspaceCaptor.getValue().id()).isEqualTo(view.id());
        assertThat(workspaceCaptor.getValue().securityMode()).isEqualTo(Workspace.SecurityMode.E2EE);

        ArgumentCaptor<Membership> membershipCaptor = ArgumentCaptor.forClass(Membership.class);
        verify(repository).save(membershipCaptor.capture());
        assertThat(membershipCaptor.getValue().role()).isEqualTo(Membership.Role.OWNER);
        assertThat(membershipCaptor.getValue().status()).isEqualTo(Membership.Status.ACTIVE);

        // P2-10: an E2EE workspace has no default GROUP chat (E2EE supports DIRECT only).
        verify(chat, never()).createDefaultGroupChat(any());

        ArgumentCaptor<AuditRecord> auditCaptor = ArgumentCaptor.forClass(AuditRecord.class);
        verify(audit).append(auditCaptor.capture());
        assertThat(auditCaptor.getValue().action()).isEqualTo("workspace.created");
        assertThat(auditCaptor.getValue().workspaceId()).isEqualTo(view.id());
        verify(tenant).activate(any());
    }

    @Test
    void rejectsInvalidSecurityMode() {
        WorkspaceOnboardingService service = new WorkspaceOnboardingService(
                mock(TenantContext.class), mock(WorkspaceRepository.class),
                mock(ChatProvisioningPort.class), new WorkspaceSlugFactory(), mock(AuditPort.class),
                Instant::now);

        assertThatThrownBy(() -> service.create(
                new Principal(UUID.randomUUID(), null, null, "req"),
                new CreateWorkspaceCommand("Name", "SOMETHING")))
                .isInstanceOf(DomainException.class)
                .hasMessageContaining("security_mode");
    }

    @Test
    void rejectsBlankName() {
        WorkspaceOnboardingService service = new WorkspaceOnboardingService(
                mock(TenantContext.class), mock(WorkspaceRepository.class),
                mock(ChatProvisioningPort.class), new WorkspaceSlugFactory(), mock(AuditPort.class),
                Instant::now);

        assertThatThrownBy(() -> service.create(
                new Principal(UUID.randomUUID(), null, null, "req"),
                new CreateWorkspaceCommand("  ", "MANAGED")))
                .isInstanceOf(DomainException.class)
                .hasMessageContaining("blank");
    }
}
