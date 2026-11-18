package ru.krug.backend.auth.application.port;

import ru.krug.backend.auth.application.model.AuthenticatedUser;
import ru.krug.backend.auth.application.model.KeycloakIdentity;

/**
 * Published JIT provisioning port used by the Keycloak device-binding strategy.
 */
public interface JitProvisioningPort {

    AuthenticatedUser ensure(KeycloakIdentity identity, String requestId);
}
