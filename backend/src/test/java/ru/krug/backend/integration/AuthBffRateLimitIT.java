package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MvcResult;

import ru.krug.backend.support.IntegrationTestBase;
import ru.krug.backend.support.KeycloakWireMock;
import ru.krug.backend.support.TestMailConfig;

/** Per-email rate limits on the public auth endpoints return 429 + Retry-After. */
@SpringBootTest(properties = {
        "krug.content.key=auth-bff-test-content-key-please-change-32",
        "krug.auth-bff.code.secret-key=auth-bff-test-email-secret-key-please-change-32",
        "krug.auth-bff.cleanup.enabled=false",
        "krug.auth-bff.keycloak.admin-password=auth-bff-test-admin",
        "krug.auth-bff.rate-limit.register-per-email=1",
        "krug.auth-bff.rate-limit.register-per-ip=1000",
        "krug.auth-bff.rate-limit.login-per-email=2",
        "krug.auth-bff.rate-limit.login-per-ip=1000",
        "krug.auth-bff.rate-limit.resend-per-email=100"
})
@ActiveProfiles("keycloak")
@Import(TestMailConfig.class)
class AuthBffRateLimitIT extends IntegrationTestBase {

    private static final String PASSWORD = "VeryStrongPass123!";

    @DynamicPropertySource
    static void keycloak(DynamicPropertyRegistry registry) {
        registry.add("krug.auth-bff.keycloak.base-url", KeycloakWireMock::baseUrl);
        registry.add("krug.oidc.issuer", KeycloakWireMock::issuer);
        registry.add("krug.oidc.jwk-set-uri", KeycloakWireMock::jwksUri);
    }

    @BeforeEach
    void resetFakeIdp() {
        KeycloakWireMock.reset();
    }

    @Test
    void thirdRegisterForTheSameEmailIs429() throws Exception {
        String email = "rate-limit-" + UUID.randomUUID().toString().substring(0, 8)
                + "@krug.test";
        assertThat(register(email).getResponse().getStatus()).isEqualTo(202);
        MvcResult limited = register(email);
        assertThat(limited.getResponse().getStatus()).isEqualTo(429);
        assertThat(json(limited).get("code").asText()).isEqualTo("RATE_LIMITED");
        assertThat(limited.getResponse().getHeader("Retry-After")).isNotBlank();
    }

    @Test
    void thirdLoginForTheSameEmailIs429() throws Exception {
        String email = "rate-login-" + UUID.randomUUID().toString().substring(0, 8)
                + "@krug.test";
        assertThat(login(email).getResponse().getStatus()).isEqualTo(401);
        assertThat(login(email).getResponse().getStatus()).isEqualTo(401);
        MvcResult limited = login(email);
        assertThat(limited.getResponse().getStatus()).isEqualTo(429);
        assertThat(json(limited).get("code").asText()).isEqualTo("RATE_LIMITED");
        assertThat(limited.getResponse().getHeader("Retry-After")).isNotBlank();
    }

    private MvcResult register(String email) throws Exception {
        return mockMvc.perform(post("/api/v1/auth/register")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "email", email,
                                "display_name", "Rate Limit",
                                "password", PASSWORD))))
                .andReturn();
    }

    private MvcResult login(String email) throws Exception {
        return mockMvc.perform(post("/api/v1/auth/login")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "email", email,
                                "password", "WrongPassword123!"))))
                .andReturn();
    }
}
