package ru.krug.backend.shared.infrastructure.security;

import java.time.Duration;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Profile;
import org.springframework.security.oauth2.core.DelegatingOAuth2TokenValidator;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtIssuerValidator;
import org.springframework.security.oauth2.jwt.JwtTimestampValidator;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;

import ru.krug.backend.shared.infrastructure.config.KrugProperties;

/**
 * Keycloak OIDC resource server for the {@code keycloak} and {@code prod} profiles.
 *
 * <p>JWKS is fetched lazily from {@code jwk-set-uri}; application startup does not require
 * Keycloak to be reachable (useful for tests and for starting before the IdP). Validation:
 * signature, {@code iss}, {@code exp}/{@code nbf} with clock skew, {@code aud},
 * {@code azp}. Tokens are never logged.</p>
 */
@Configuration
@Profile({"keycloak", "prod"})
public class KeycloakJwtDecoderConfig {

    @Bean
    public JwtDecoder jwtDecoder(KrugProperties properties) {
        KrugProperties.Oidc oidc = properties.oidc();
        String issuer = require(oidc.issuer(), "KRUG_OIDC_ISSUER");
        String jwkSetUri = require(oidc.jwkSetUri(), "KRUG_OIDC_JWKS_URI");
        String audience = require(oidc.audience(), "KRUG_OIDC_AUDIENCE");
        String authorizedParty = require(oidc.authorizedParty(), "KRUG_OIDC_AZP");
        Duration clockSkew = oidc.clockSkew() == null ? Duration.ofSeconds(30) : oidc.clockSkew();

        NimbusJwtDecoder decoder = NimbusJwtDecoder.withJwkSetUri(jwkSetUri).build();
        decoder.setJwtValidator(new DelegatingOAuth2TokenValidator<>(
                new JwtTimestampValidator(clockSkew),
                new JwtIssuerValidator(issuer),
                KeycloakJwtValidators.audience(audience),
                KeycloakJwtValidators.authorizedParty(authorizedParty)));
        return decoder;
    }

    private static String require(String value, String name) {
        if (value == null || value.isBlank() || value.contains("${")) {
            throw new IllegalStateException(name + " must be set for the keycloak/prod profile");
        }
        return value;
    }
}
