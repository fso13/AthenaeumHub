package ru.krug.backend.auth.application.model;

/**
 * Claims extracted from a Keycloak access token. Framework-free so application tests do
 * not need Spring Security.
 */
public record KeycloakIdentity(
        String subject,
        String email,
        boolean emailVerified,
        String preferredUsername,
        String displayName) {
}
