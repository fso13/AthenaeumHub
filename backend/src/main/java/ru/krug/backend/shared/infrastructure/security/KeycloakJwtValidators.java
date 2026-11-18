package ru.krug.backend.shared.infrastructure.security;

import java.util.List;

import org.springframework.security.oauth2.core.OAuth2Error;
import org.springframework.security.oauth2.core.OAuth2TokenValidator;
import org.springframework.security.oauth2.core.OAuth2TokenValidatorResult;
import org.springframework.security.oauth2.jwt.Jwt;

/**
 * Keycloak-specific JWT validators (SYSTEM-ANALYSIS §11.5, ADR-17).
 *
 * <p>The issuer, timestamps and signature are handled by Nimbus/Spring; these two rules
 * close the gap between "a token signed by the realm" and "a token issued to our SPA for
 * our API": the access token must carry the {@code krug-api} audience and the
 * {@code krug-web} authorized party.</p>
 */
public final class KeycloakJwtValidators {

    private KeycloakJwtValidators() {
    }

    public static OAuth2TokenValidator<Jwt> audience(String requiredAudience) {
        return token -> {
            List<String> audience = token.getAudience();
            if (audience != null && audience.contains(requiredAudience)) {
                return OAuth2TokenValidatorResult.success();
            }
            return OAuth2TokenValidatorResult.failure(new OAuth2Error("invalid_token",
                    "Required audience is missing", null));
        };
    }

    public static OAuth2TokenValidator<Jwt> authorizedParty(String expectedClientId) {
        return token -> {
            String azp = token.getClaimAsString("azp");
            if (expectedClientId.equals(azp)) {
                return OAuth2TokenValidatorResult.success();
            }
            return OAuth2TokenValidatorResult.failure(new OAuth2Error("invalid_token",
                    "Authorized party is not the expected client", null));
        };
    }
}
