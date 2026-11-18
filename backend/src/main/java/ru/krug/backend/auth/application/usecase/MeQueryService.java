package ru.krug.backend.auth.application.usecase;

import java.util.List;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.auth.application.model.MeView;
import ru.krug.backend.auth.application.model.UserProfileView;
import ru.krug.backend.auth.application.port.UserProfilePort;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.TenantContext;
import ru.krug.backend.workspace.application.model.WorkspaceMembershipView;
import ru.krug.backend.workspace.application.port.WorkspaceDirectoryPort;

/**
 * {@code GET /me}: profile plus active workspace memberships. An empty list is a valid
 * state (AUTH-D-04); onboarding happens through {@code POST /workspaces}.
 */
@Service
public class MeQueryService {

    private final TenantContext tenantContext;
    private final UserProfilePort userProfile;
    private final WorkspaceDirectoryPort workspaceDirectory;

    public MeQueryService(TenantContext tenantContext, UserProfilePort userProfile,
                          WorkspaceDirectoryPort workspaceDirectory) {
        this.tenantContext = tenantContext;
        this.userProfile = userProfile;
        this.workspaceDirectory = workspaceDirectory;
    }

    @Transactional(readOnly = true)
    public MeView me(Principal principal) {
        tenantContext.activate(principal);
        UserProfileView user = userProfile.requireProfile(principal.userId());
        List<WorkspaceMembershipView> workspaces =
                workspaceDirectory.listActiveMemberships(principal.userId());
        UUID defaultWorkspaceId = workspaces.isEmpty() ? null : workspaces.get(0).id();
        return new MeView(principal.userId(), user.displayName(), user.email(),
                user.platformAdmin(), workspaces, defaultWorkspaceId);
    }
}
