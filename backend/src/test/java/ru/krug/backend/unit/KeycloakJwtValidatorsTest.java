package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Instant;
import java.util.List;

import org.junit.jupiter.api.Test;
import org.springframework.security.oauth2.jwt.Jwt;

import ru.krug.backend.shared.infrastructure.security.KeycloakJwtValidators;

class KeycloakJwtValidatorsTest {

    @Test
    void audienceValidatorAcceptsOnlyKrugApi() {
        assertThat(KeycloakJwtValidators.audience("krug-api").validate(jwt(List.of("account",
                "krug-api"), "krug-web")).hasErrors()).isFalse();
        assertThat(KeycloakJwtValidators.audience("krug-api").validate(jwt(List.of("account"),
                "krug-web")).hasErrors()).isTrue();
    }

    @Test
    void authorizedPartyValidatorRequiresKrugWeb() {
        assertThat(KeycloakJwtValidators.authorizedParty("krug-web").validate(jwt(List.of("krug-api"),
                "krug-web")).hasErrors()).isFalse();
        assertThat(KeycloakJwtValidators.authorizedParty("krug-web").validate(jwt(List.of("krug-api"),
                "other-client")).hasErrors()).isTrue();
        assertThat(KeycloakJwtValidators.authorizedParty("krug-web").validate(jwt(List.of("krug-api"),
                null)).hasErrors()).isTrue();
    }

    private static Jwt jwt(List<String> audience, String azp) {
        Jwt.Builder builder = Jwt.withTokenValue("not-a-real-token")
                .header("alg", "RS256")
                .subject("subject")
                .audience(audience)
                .issuedAt(Instant.now().minusSeconds(10))
                .expiresAt(Instant.now().plusSeconds(300));
        if (azp != null) {
            builder.claim("azp", azp);
        }
        return builder.build();
    }
}
