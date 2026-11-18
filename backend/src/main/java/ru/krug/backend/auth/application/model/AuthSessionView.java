package ru.krug.backend.auth.application.model;

/** Public session payload; tokens are opaque Keycloak artifacts and never logged. */
public record AuthSessionView(
        String accessToken,
        String refreshToken,
        long expiresIn,
        String tokenType,
        AuthUserView user) {
}
