package ru.krug.backend.auth.api;

import java.time.Duration;
import java.util.regex.Pattern;

import org.springframework.http.ResponseCookie;
import org.springframework.stereotype.Component;

import ru.krug.backend.auth.application.port.AuthBffSettings;

/**
 * #103: issues and clears the browser refresh-token cookie.
 *
 * <p>The refresh token never appears in a JSON response. The cookie is
 * {@code HttpOnly}, {@code SameSite=Lax} and scoped to {@code /api/v1/auth}, so it is
 * never attached to ordinary API calls and JavaScript cannot read it. {@code Secure} is
 * on in prod and off for plain-http localhost development (configuration, not a branch on
 * the request). {@code Max-Age} is deliberately bounded: Keycloak remains the authority on
 * whether the token is still valid.</p>
 */
@Component
public class RefreshCookieFactory {

    /**
     * Keycloak refresh tokens are opaque ASCII (JWTs/base64url). The pattern rejects
     * whitespace, separators and CR/LF so a compromised IdP response can never inject a
     * second {@code Set-Cookie} header.
     */
    private static final Pattern SAFE_TOKEN = Pattern.compile("[A-Za-z0-9._~+/=-]{1,4096}");

    private final AuthBffSettings settings;

    public RefreshCookieFactory(AuthBffSettings settings) {
        this.settings = settings;
    }

    public String cookieName() {
        return settings.refreshCookieName();
    }

    public ResponseCookie issue(String refreshToken) {
        if (refreshToken == null || !SAFE_TOKEN.matcher(refreshToken).matches()) {
            // Never log the value: it is a live credential.
            throw new IllegalStateException("Keycloak returned an unsafe refresh token");
        }
        return base(refreshToken)
                .maxAge(settings.refreshCookieMaxAge())
                .build();
    }

    public ResponseCookie clear() {
        return base("")
                .maxAge(Duration.ZERO)
                .build();
    }

    private ResponseCookie.ResponseCookieBuilder base(String value) {
        return ResponseCookie.from(settings.refreshCookieName(), value)
                .httpOnly(true)
                .secure(settings.refreshCookieSecure())
                .sameSite(settings.refreshCookieSameSite())
                .path(settings.refreshCookiePath());
    }
}
