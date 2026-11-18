package ru.krug.backend.auth.application.port;

import ru.krug.backend.auth.application.model.KeycloakIdentity;
import ru.krug.backend.auth.application.model.TokenSet;

/**
 * Keycloak token endpoint / userinfo port. The client is the public {@code krug-web} SPA
 * client and the calls are server-to-server (internal URL).
 */
public interface TokenExchangePort {

    /**
     * @throws InvalidGrantException on invalid credentials / disabled user
     * @throws ProviderUnavailableException on transport or 5xx failures
     */
    TokenSet passwordGrant(String email, String password);

    /**
     * @throws InvalidGrantException when the refresh token is expired/revoked
     */
    TokenSet refresh(String refreshToken);

    /** Revokes the refresh token (Keycloak logout endpoint). */
    void revoke(String refreshToken);

    /**
     * Resolves the authoritative identity behind an access token via the userinfo
     * endpoint; the token signature is verified by Keycloak, not by the BFF.
     */
    KeycloakIdentity userInfo(String accessToken);
}
