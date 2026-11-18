package ru.krug.backend.auth.api.dto;

/** Response DTO for login/verify/refresh (OpenAPI {@code AuthSession}). */
public record AuthSessionResponse(
        String accessToken,
        String refreshToken,
        long expiresIn,
        String tokenType,
        AuthUserResponse user) {
}
