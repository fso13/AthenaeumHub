package ru.krug.backend.auth.api.dto;

/**
 * Response DTO for login/verify/refresh (OpenAPI {@code AuthSession}).
 *
 * <p>#103: the refresh token is deliberately absent. It is delivered as an HttpOnly
 * cookie (see {@code RefreshCookieFactory}); only the short-lived access token is exposed
 * to JavaScript.</p>
 */
public record AuthSessionResponse(
        String accessToken,
        long expiresIn,
        String tokenType,
        AuthUserResponse user) {
}
