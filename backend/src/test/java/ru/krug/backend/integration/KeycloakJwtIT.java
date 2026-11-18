package ru.krug.backend.integration;

import static com.github.tomakehurst.wiremock.client.WireMock.aResponse;
import static com.github.tomakehurst.wiremock.client.WireMock.urlEqualTo;
import static com.github.tomakehurst.wiremock.core.WireMockConfiguration.options;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.github.tomakehurst.wiremock.WireMockServer;
import com.nimbusds.jose.JOSEObjectType;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.RSASSASigner;
import com.nimbusds.jose.jwk.RSAKey;
import com.nimbusds.jose.jwk.gen.RSAKeyGenerator;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MvcResult;

import ru.krug.backend.support.IntegrationTestBase;
import ru.krug.backend.support.OpenApiContract;

/**
 * Real JWT decoding against a WireMock JWKS endpoint: no real Keycloak container is
 * required, but signature, issuer, audience, azp, clock skew and device binding all run
 * through the production decoder.
 */
@SpringBootTest(properties = {
        "krug.content.key=keycloak-test-content-key-please-change-32-bytes"
})
@ActiveProfiles("keycloak")
class KeycloakJwtIT extends IntegrationTestBase {

    private static final OpenApiContract CONTRACT = OpenApiContract.load();
    private static final RSAKey SIGNING_KEY;
    private static final RSAKey WRONG_KEY;
    private static final WireMockServer WIREMOCK;
    private static final String ISSUER;

    static {
        try {
            SIGNING_KEY = new RSAKeyGenerator(2048).keyID("krug-test").generate();
            WRONG_KEY = new RSAKeyGenerator(2048).keyID("krug-test").generate();
            WIREMOCK = new WireMockServer(options().dynamicPort());
            WIREMOCK.start();
            ISSUER = "http://localhost:" + WIREMOCK.port() + "/realms/krug";
            Map<String, Object> jwk = new LinkedHashMap<>();
            jwk.put("kty", "RSA");
            jwk.put("kid", SIGNING_KEY.getKeyID());
            jwk.put("use", "sig");
            jwk.put("alg", "RS256");
            jwk.put("n", SIGNING_KEY.getModulus().toString());
            jwk.put("e", SIGNING_KEY.getPublicExponent().toString());
            String jwks = new ObjectMapper().writeValueAsString(Map.of("keys", List.of(jwk)));
            WIREMOCK.stubFor(com.github.tomakehurst.wiremock.client.WireMock.get(
                    urlEqualTo("/realms/krug/protocol/openid-connect/certs"))
                    .willReturn(aResponse().withHeader("Content-Type", "application/json")
                            .withBody(jwks)));
        } catch (Exception ex) {
            throw new IllegalStateException("Cannot start the JWKS stub", ex);
        }
    }

    @DynamicPropertySource
    static void oidcProperties(DynamicPropertyRegistry registry) {
        registry.add("krug.oidc.issuer", () -> ISSUER);
        registry.add("krug.oidc.jwk-set-uri",
                () -> ISSUER + "/protocol/openid-connect/certs");
        registry.add("krug.oidc.audience", () -> "krug-api");
        registry.add("krug.oidc.authorized-party", () -> "krug-web");
    }

    @AfterAll
    static void stopStub() {
        WIREMOCK.stop();
    }

    @Test
    void validKeycloakTokenAuthenticatesMeAndOnboardsWorkspace() throws Exception {
        String subject = "kc-jwt-" + UUID.randomUUID();
        String token = token(SIGNING_KEY, ISSUER, "krug-api", "krug-web",
                subject, Instant.now().plusSeconds(600));

        MvcResult me = mockMvc.perform(get("/api/v1/me")
                        .header("Authorization", "Bearer " + token))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode meJson = json(me);
        CONTRACT.assertValid("MeResponse", meJson);
        assertThat(meJson.get("workspaces")).isEmpty();

        MvcResult device = mockMvc.perform(post("/api/v1/devices")
                        .header("Authorization", "Bearer " + token)
                        .header("Idempotency-Key", UUID.randomUUID().toString())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "name", "JWT Chrome",
                                "platform", "WEB",
                                "app_version", "1.0.0"))))
                .andExpect(status().isCreated())
                .andReturn();
        CONTRACT.assertValid("Device", json(device));
        String deviceId = json(device).get("id").asText();

        MvcResult workspace = mockMvc.perform(post("/api/v1/workspaces")
                        .header("Authorization", "Bearer " + token)
                        .header("X-Device-Id", deviceId)
                        .header("Idempotency-Key", UUID.randomUUID().toString())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "name", "JWT Workspace",
                                "security_mode", "MANAGED"))))
                .andExpect(status().isCreated())
                .andReturn();
        CONTRACT.assertValid("WorkspaceSummary", json(workspace));

        mockMvc.perform(get("/api/v1/workspaces/{id}/chats",
                        json(workspace).get("id").asText())
                        .header("Authorization", "Bearer " + token)
                        .header("X-Device-Id", deviceId))
                .andExpect(status().isOk());
    }

    @Test
    void expiredTokenReturns401() throws Exception {
        String token = token(SIGNING_KEY, ISSUER, "krug-api", "krug-web",
                "kc-expired-" + UUID.randomUUID(), Instant.now().minusSeconds(60));
        MvcResult result = mockMvc.perform(get("/api/v1/me")
                        .header("Authorization", "Bearer " + token))
                .andExpect(status().isUnauthorized())
                .andReturn();
        assertThat(json(result).get("code").asText())
                .isIn("TOKEN_EXPIRED", "UNAUTHENTICATED");
    }

    @Test
    void expirationInsideClockSkewIsAccepted() throws Exception {
        String token = token(SIGNING_KEY, ISSUER, "krug-api", "krug-web",
                "kc-skew-" + UUID.randomUUID(), Instant.now().minusSeconds(5));
        mockMvc.perform(get("/api/v1/me").header("Authorization", "Bearer " + token))
                .andExpect(status().isOk());
    }

    @Test
    void wrongAudienceAuthorizedPartyOrIssuerReturns401() throws Exception {
        String validSubject = "kc-claims-" + UUID.randomUUID();
        assertUnauthorized(token(SIGNING_KEY, ISSUER, "other-api", "krug-web",
                validSubject, Instant.now().plusSeconds(600)));
        assertUnauthorized(token(SIGNING_KEY, ISSUER, "krug-api", "other-client",
                validSubject, Instant.now().plusSeconds(600)));
        assertUnauthorized(token(SIGNING_KEY, "http://localhost:9999/realms/krug", "krug-api",
                "krug-web", validSubject, Instant.now().plusSeconds(600)));
    }

    @Test
    void tamperedSignatureReturns401() throws Exception {
        assertUnauthorized(token(WRONG_KEY, ISSUER, "krug-api", "krug-web",
                "kc-tampered-" + UUID.randomUUID(), Instant.now().plusSeconds(600)));
    }

    private void assertUnauthorized(String token) throws Exception {
        MvcResult result = mockMvc.perform(get("/api/v1/me")
                        .header("Authorization", "Bearer " + token))
                .andExpect(status().isUnauthorized())
                .andReturn();
        assertThat(json(result).get("code").asText()).isEqualTo("UNAUTHENTICATED");
        assertThat(json(result).has("request_id")).isTrue();
    }

    private static String token(RSAKey key, String issuer, String audience, String azp,
                                String subject, Instant expiresAt) throws Exception {
        Instant now = Instant.now();
        JWTClaimsSet claims = new JWTClaimsSet.Builder()
                .issuer(issuer)
                .audience(List.of(audience))
                .subject(subject)
                .claim("azp", azp)
                .claim("email", subject + "@krug.test")
                .claim("email_verified", true)
                .claim("preferred_username", subject)
                .claim("name", "JWT User")
                .issueTime(java.util.Date.from(now.minusSeconds(1200)))
                .expirationTime(java.util.Date.from(expiresAt))
                .build();
        SignedJWT jwt = new SignedJWT(new JWSHeader.Builder(JWSAlgorithm.RS256)
                .keyID(key.getKeyID())
                .type(JOSEObjectType.JWT)
                .build(), claims);
        jwt.sign(new RSASSASigner(key.toPrivateKey()));
        return jwt.serialize();
    }
}
