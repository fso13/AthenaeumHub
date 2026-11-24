package ru.krug.backend.workspace.application.model;

import java.util.UUID;

/** Read model for workspace lists (GET /me, POST /workspaces). */
public record WorkspaceMembershipView(
        UUID id,
        String name,
        String slug,
        String role,
        String securityMode,
        String description,
        UUID logoFileId) {

    public WorkspaceMembershipView(UUID id, String name, String slug, String role,
                                   String securityMode) {
        this(id, name, slug, role, securityMode, null, null);
    }
}
