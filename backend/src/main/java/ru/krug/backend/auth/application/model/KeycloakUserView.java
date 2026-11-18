package ru.krug.backend.auth.application.model;

import java.util.UUID;

/** Read model of a Keycloak user from the Admin API. */
public record KeycloakUserView(
        UUID id,
        String username,
        String email,
        String displayName,
        boolean enabled,
        boolean emailVerified) {
}
