package ru.krug.backend.bot.application.usecase;

import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;

import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;
import ru.krug.backend.workspace.application.model.WorkspaceAccessContext;
import ru.krug.backend.workspace.application.usecase.WorkspacePermissionGuard;
import ru.krug.backend.workspace.domain.model.Membership;

/**
 * Workspace gate for the bot management surface. The task requires OWNER/ADMIN (not the
 * configurable workspace permission matrix), so the role is checked directly:
 *
 * <ul>
 *   <li>any ACTIVE member may list bots (names/scopes/status are not credentials);</li>
 *   <li>create/update/disable/rotate/install require workspace OWNER or ADMIN;</li>
 *   <li>a non-member or a foreign workspace is a hidden 403, as everywhere else.</li>
 * </ul>
 */
@Service
public class BotAccessGuard {

    private final WorkspacePermissionGuard workspaceGuard;

    public BotAccessGuard(WorkspacePermissionGuard workspaceGuard) {
        this.workspaceGuard = workspaceGuard;
    }

    public WorkspaceAccessContext requireMember(Principal principal, UUID workspaceId) {
        return workspaceGuard.requireMember(principal, workspaceId);
    }

    public WorkspaceAccessContext requireManager(Principal principal, UUID workspaceId) {
        WorkspaceAccessContext context = workspaceGuard.requireMember(principal, workspaceId);
        Membership.Role role = context.role();
        if (role != Membership.Role.OWNER && role != Membership.Role.ADMIN) {
            throw DomainException.forbidden(ErrorCode.WORKSPACE_PERMISSION_DENIED,
                    "Only a workspace OWNER or ADMIN can manage bots",
                    Map.of("required", "OWNER,ADMIN"));
        }
        return context;
    }
}
