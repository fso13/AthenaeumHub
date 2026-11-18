package ru.krug.backend.notification.application.port;

import java.util.Optional;
import java.util.UUID;

/**
 * Resolves a workspace for workspace-global preferences when the access token has no
 * workspace claim (Keycloak principals). Dev/test tokens already carry the claim.
 */
public interface WorkspaceLookupPort {

    Optional<UUID> defaultWorkspace(UUID userId);
}
