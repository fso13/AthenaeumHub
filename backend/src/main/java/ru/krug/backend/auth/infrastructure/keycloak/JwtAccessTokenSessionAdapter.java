package ru.krug.backend.auth.infrastructure.keycloak;

import java.util.Optional;

import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtException;
import org.springframework.stereotype.Component;

import ru.krug.backend.auth.application.port.AccessTokenSessionPort;

/**
 * Reads the {@code sid} claim from a signed Keycloak access token. The token was just
 * obtained through the BFF token exchange; the decoder additionally verifies signature,
 * issuer and audience, so a forged token cannot influence the timeout decision. The token
 * itself is never logged or persisted.
 */
@Component
public class JwtAccessTokenSessionAdapter implements AccessTokenSessionPort {

    private final JwtDecoder jwtDecoder;

    public JwtAccessTokenSessionAdapter(JwtDecoder jwtDecoder) {
        this.jwtDecoder = jwtDecoder;
    }

    @Override
    public Optional<String> sessionId(String accessToken) {
        if (accessToken == null || accessToken.isBlank()) {
            return Optional.empty();
        }
        try {
            Jwt jwt = jwtDecoder.decode(accessToken);
            String sid = jwt.getClaimAsString("sid");
            if (sid == null || sid.isBlank() || sid.length() > 128) {
                return Optional.empty();
            }
            return Optional.of(sid.strip());
        } catch (JwtException | IllegalArgumentException ex) {
            // Dev tokens and non-Keycloak issuers carry no sid. Timeout tracking is then
            // skipped rather than failing the refresh.
            return Optional.empty();
        }
    }
}
