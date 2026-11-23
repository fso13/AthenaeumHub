package ru.krug.backend.workspace.application.model;

import java.time.Instant;

/**
 * #100 public invite preview. It carries the workspace name/slug, the role the invite
 * grants and whether the invite is bound to an email. The invited address, token and hash
 * are never part of this view.
 */
public record WorkspaceInvitePreviewView(String workspaceName, String workspaceSlug,
                                         String role, boolean emailBound, Instant expiresAt) {
}
