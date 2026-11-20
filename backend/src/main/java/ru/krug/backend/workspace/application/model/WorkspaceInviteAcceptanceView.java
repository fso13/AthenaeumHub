package ru.krug.backend.workspace.application.model;

import java.util.UUID;

/** Result of accepting an email-link token (no email is sent by this backend). */
public record WorkspaceInviteAcceptanceView(UUID workspaceId, String workspaceName,
                                            String workspaceSlug, String role,
                                            boolean alreadyMember) {
}
