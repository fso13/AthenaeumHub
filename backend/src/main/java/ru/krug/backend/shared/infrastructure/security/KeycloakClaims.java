package ru.krug.backend.shared.infrastructure.security;

import java.util.UUID;

import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;

import ru.krug.backend.auth.application.model.KeycloakIdentity;

/** Maps validated Keycloak access-token claims to the application identity model. */
final class KeycloakClaims {

    private KeycloakClaims() {
    }

    static KeycloakIdentity identity(Jwt jwt) {
        String preferredUsername = jwt.getClaimAsString("preferred_username");
        String givenName = jwt.getClaimAsString("given_name");
        String familyName = jwt.getClaimAsString("family_name");
        // The Auth BFF sets firstName = lastName = display_name to satisfy Keycloak 26's
        // user profile; for those users given_name is the exact requested display name.
        // Users managed outside the BFF keep the full name claim.
        String bffDisplayName = givenName != null && givenName.equals(familyName)
                ? givenName : null;
        String displayName = firstNonBlank(bffDisplayName,
                jwt.getClaimAsString("name"),
                joinName(givenName, familyName), preferredUsername, jwt.getSubject());
        return new KeycloakIdentity(
                jwt.getSubject(),
                jwt.getClaimAsString("email"),
                Boolean.TRUE.equals(jwt.getClaim("email_verified")),
                preferredUsername,
                displayName);
    }

    static UUID parseUuid(String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        try {
            return UUID.fromString(value.strip());
        } catch (IllegalArgumentException ex) {
            return null;
        }
    }

    private static String joinName(String given, String family) {
        String left = given == null ? "" : given.strip();
        String right = family == null ? "" : family.strip();
        String joined = (left + " " + right).strip();
        return joined.isEmpty() ? null : joined;
    }

    private static String firstNonBlank(String... values) {
        for (String value : values) {
            if (value != null && !value.isBlank()) {
                return value.strip();
            }
        }
        return null;
    }
}
