package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.UUID;

import org.junit.jupiter.api.Test;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MvcResult;

import ru.krug.backend.support.IntegrationTestBase;

@SpringBootTest(properties = {
        "krug.auth.jwt-secret=prod-test-jwt-secret-please-change-32-bytes",
        "krug.content.key=prod-test-content-key-please-change-32-bytes",
        "krug.oidc.issuer=http://localhost:8180/realms/krug",
        "krug.oidc.jwk-set-uri=http://localhost:8180/realms/krug/protocol/openid-connect/certs"
})
@AutoConfigureMockMvc
@ActiveProfiles("prod")
class ProdProfileIT extends IntegrationTestBase {

    @Test
    void devSessionIsAbsentInProdAndReturns404() throws Exception {
        MvcResult result = mockMvc.perform(post("/api/v1/dev/session"))
                .andExpect(status().isNotFound())
                .andReturn();
        assertThat(json(result).get("code").asText()).isEqualTo("NOT_FOUND");
    }

    @Test
    void healthAndAuthStillWorkInProd() throws Exception {
        mockMvc.perform(get("/api/v1/health")).andExpect(status().isOk());
        mockMvc.perform(get("/api/v1/sync").param("workspace_id", UUID.randomUUID().toString()))
                .andExpect(status().isUnauthorized());
    }
}
