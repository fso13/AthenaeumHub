package ru.krug.backend.workspace.application.usecase;

import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.audit.application.model.AuditRecord;
import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.chat.application.command.DefaultChatCommand;
import ru.krug.backend.chat.application.port.ChatProvisioningPort;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.E2eeSettingsPort;
import ru.krug.backend.shared.application.port.TenantContext;
import ru.krug.backend.shared.error.ErrorCode;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.workspace.application.command.CreateWorkspaceCommand;
import ru.krug.backend.workspace.application.model.WorkspaceSummaryView;
import ru.krug.backend.workspace.application.service.WorkspaceSlugFactory;
import ru.krug.backend.workspace.domain.model.Membership;
import ru.krug.backend.workspace.domain.model.Workspace;
import ru.krug.backend.workspace.domain.repository.WorkspaceRepository;

/**
 * Onboarding transaction: workspace, OWNER membership, default «Общий чат», audit.
 * The caller (CreateWorkspaceUseCase) owns the idempotency reservation.
 */
@Service
public class WorkspaceOnboardingService {

    public static final String DEFAULT_CHAT_NAME = "Общий чат";

    private final TenantContext tenantContext;
    private final WorkspaceRepository workspaceRepository;
    private final ChatProvisioningPort chatProvisioning;
    private final WorkspaceSlugFactory slugs;
    private final AuditPort audit;
    private final ClockPort clock;
    private final E2eeSettingsPort e2eeSettings;

    /** Back-compat constructor for unit tests (E2EE allowed). */
    public WorkspaceOnboardingService(TenantContext tenantContext,
                                      WorkspaceRepository workspaceRepository,
                                      ChatProvisioningPort chatProvisioning,
                                      WorkspaceSlugFactory slugs, AuditPort audit,
                                      ClockPort clock) {
        this(tenantContext, workspaceRepository, chatProvisioning, slugs, audit, clock,
                () -> true);
    }

    @org.springframework.beans.factory.annotation.Autowired
    public WorkspaceOnboardingService(TenantContext tenantContext,
                                      WorkspaceRepository workspaceRepository,
                                      ChatProvisioningPort chatProvisioning,
                                      WorkspaceSlugFactory slugs, AuditPort audit,
                                      ClockPort clock, E2eeSettingsPort e2eeSettings) {
        this.tenantContext = tenantContext;
        this.workspaceRepository = workspaceRepository;
        this.chatProvisioning = chatProvisioning;
        this.slugs = slugs;
        this.audit = audit;
        this.clock = clock;
        this.e2eeSettings = e2eeSettings;
    }

    @Transactional
    public WorkspaceSummaryView create(Principal principal, CreateWorkspaceCommand command) {
        String name = validateName(command.name());
        Workspace.SecurityMode securityMode = securityMode(command.securityMode());
        if (securityMode == Workspace.SecurityMode.E2EE && !e2eeSettings.enabled()) {
            throw DomainException.conflict(ErrorCode.E2EE_DISABLED,
                    "E2EE is disabled by the feature flag", Map.of("flag", "e2ee.enabled"));
        }
        UUID workspaceId = UUID.randomUUID();
        Principal scoped = principal.withWorkspace(workspaceId);
        tenantContext.activate(scoped);

        Workspace workspace = Workspace.create(workspaceId, name, slugs.create(name),
                securityMode, principal.userId());
        workspaceRepository.save(workspace);
        workspaceRepository.save(Membership.owner(workspaceId, principal.userId()));

        // P2-10: an E2EE workspace must not get a default GROUP chat — E2EE supports only
        // DIRECT in E7 (E2EE_GROUP_NOT_SUPPORTED). The user creates an explicit DIRECT chat
        // once both participants have an e2ee-capable device. MANAGED onboarding is
        // unchanged.
        if (securityMode == Workspace.SecurityMode.MANAGED) {
            chatProvisioning.createDefaultGroupChat(new DefaultChatCommand(UUID.randomUUID(),
                    workspaceId, principal.userId(), DEFAULT_CHAT_NAME, securityMode.name()));
        }
        audit.append(new AuditRecord(workspaceId, principal.userId(), "workspace.created",
                "workspace", workspaceId, principal.requestId(),
                Map.of("security_mode", securityMode.name()), clock.now()));

        return new WorkspaceSummaryView(workspaceId, workspace.name(), workspace.slug(),
                Membership.Role.OWNER.name(), securityMode.name());
    }

    private static String validateName(String name) {
        if (name == null || name.isBlank()) {
            throw DomainException.badRequest("name must not be blank",
                    Map.of("field", "name"));
        }
        String normalized = name.strip();
        if (normalized.length() > 120) {
            throw DomainException.badRequest("name must be at most 120 characters",
                    Map.of("field", "name", "max_length", 120));
        }
        return normalized;
    }

    private static Workspace.SecurityMode securityMode(String value) {
        if (value == null || value.isBlank()) {
            throw DomainException.badRequest("security_mode is required",
                    Map.of("field", "security_mode"));
        }
        try {
            return Workspace.SecurityMode.valueOf(value);
        } catch (IllegalArgumentException ex) {
            throw DomainException.badRequest("security_mode must be MANAGED or E2EE",
                    Map.of("field", "security_mode", "allowed", "MANAGED,E2EE"));
        }
    }
}
