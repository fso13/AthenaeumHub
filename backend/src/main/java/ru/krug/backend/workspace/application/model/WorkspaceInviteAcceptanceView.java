package ru.krug.backend.workspace.application.model;

import java.util.UUID;

/** Result of accepting a workspace invite token (link or single-use email invite). */
public record WorkspaceInviteAcceptanceView(UUID workspaceId, String workspaceName,
                                            String workspaceSlug, String role,
                                            boolean alreadyMember) {
}
