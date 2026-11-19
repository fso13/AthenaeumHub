package ru.krug.backend.auth.application.model;

import java.time.Instant;

/**
 * One Keycloak user session, reduced to the fields the profile UI needs. The raw admin
 * payload (IP address, username, client map) never crosses the adapter boundary; {@code
 * name} is a display label derived from the client names only.
 */
public record KeycloakSessionView(
        String id,
        String name,
        Instant createdAt,
        Instant lastAccessAt) {
}
