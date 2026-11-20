package ru.krug.backend.workspace.application.port;

import java.util.UUID;

public interface WorkspaceAccessPort {

    /**
     * @throws ru.krug.backend.shared.error.DomainException 403 when the user is not an
     *         active workspace member.
     */
    void requireActiveMember(UUID workspaceId, UUID userId);

    /** Non-throwing membership probe for transports that map denial to a soft answer. */
    boolean isActiveMember(UUID workspaceId, UUID userId);

    /** GUEST members have a lower per-file limit but share the workspace storage quota. */
    boolean isGuest(UUID workspaceId, UUID userId);

    /**
     * Workspace OWNER/ADMIN. Used for narrow moderation actions such as deleting another
     * member's global file; it never replaces {@link #requireActiveMember}.
     */
    boolean isAdmin(UUID workspaceId, UUID userId);
}
