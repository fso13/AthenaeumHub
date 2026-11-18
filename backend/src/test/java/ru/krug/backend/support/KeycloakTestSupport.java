package ru.krug.backend.support;

import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import org.springframework.test.web.servlet.request.RequestPostProcessor;

/** Keycloak-like JWT post-processors for MockMvc integration tests. */
public final class KeycloakTestSupport {

    private KeycloakTestSupport() {
    }

    public static RequestPostProcessor keycloakJwt(String subject, String email,
                                                   String preferredUsername, String name) {
        Instant now = Instant.now();
        return jwt().jwt(builder -> builder
                .subject(subject)
                .audience(List.of("krug-api"))
                .claim("azp", "krug-web")
                .claim("email", email)
                .claim("email_verified", true)
                .claim("preferred_username", preferredUsername)
                .claim("name", name)
                .issuedAt(now)
                .expiresAt(now.plusSeconds(600)));
    }

    public static String uniqueSubject(String prefix) {
        return prefix + "-" + UUID.randomUUID();
    }

    public static String uniqueEmail(String prefix) {
        return prefix + "-" + UUID.randomUUID().toString().substring(0, 12) + "@krug.test";
    }
}
