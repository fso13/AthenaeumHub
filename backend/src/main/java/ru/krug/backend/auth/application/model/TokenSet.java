package ru.krug.backend.auth.application.model;

/** Opaque Keycloak token response. Never logged or persisted. */
public record TokenSet(String accessToken, String refreshToken, long expiresIn,
                       String tokenType) {
}
