package ru.krug.backend.auth.application.model;

import java.util.List;
import java.util.UUID;

import ru.krug.backend.workspace.application.model.WorkspaceMembershipView;

/** Read model for {@code GET /me}. */
public record MeView(
        UUID userId,
        String displayName,
        String email,
        boolean platformAdmin,
        String bio,
        String phone,
        List<WorkspaceMembershipView> workspaces,
        UUID defaultWorkspaceId) {

    public MeView(UUID userId, String displayName, String email,
                  List<WorkspaceMembershipView> workspaces, UUID defaultWorkspaceId) {
        this(userId, displayName, email, false, null, null, workspaces, defaultWorkspaceId);
    }

    public MeView(UUID userId, String displayName, String email, boolean platformAdmin,
                  List<WorkspaceMembershipView> workspaces, UUID defaultWorkspaceId) {
        this(userId, displayName, email, platformAdmin, null, null, workspaces,
                defaultWorkspaceId);
    }
}
