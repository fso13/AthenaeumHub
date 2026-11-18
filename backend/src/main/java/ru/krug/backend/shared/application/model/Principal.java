package ru.krug.backend.shared.application.model;

import java.util.UUID;

/**
 * Authenticated caller, resolved by the security adapter from the JWT.
 * workspaceId is the workspace claim of the dev token.
 */
public record Principal(UUID userId, UUID deviceId, UUID workspaceId, String requestId) {

    /** Keycloak tokens have no workspace claim; callers bind the principal to the resource. */
    public Principal withWorkspace(UUID workspace) {
        return new Principal(userId, deviceId, workspace, requestId);
    }
}
