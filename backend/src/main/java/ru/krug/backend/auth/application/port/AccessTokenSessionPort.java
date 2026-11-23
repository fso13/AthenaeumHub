package ru.krug.backend.auth.application.port;

import java.util.Optional;

/**
 * Extracts the OIDC session id ({@code sid}) from a Keycloak access token (#101). The
 * implementation verifies the token with the same decoder as the resource server; an
 * unparsable token yields an empty result rather than an error, because token validation
 * is the token endpoint's responsibility on this path.
 */
public interface AccessTokenSessionPort {

    Optional<String> sessionId(String accessToken);
}
