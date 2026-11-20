package ru.krug.backend.workspace.application.port;

import java.util.UUID;

/**
 * Live presence probe for the workspace overview. Implementations count distinct ACTIVE
 * members with a live realtime connection in the workspace. Presence is a single-node
 * in-process signal; it is deliberately not persisted and exposes no per-user data.
 */
public interface WorkspacePresencePort {

    int onlineMemberCount(UUID workspaceId);
}
