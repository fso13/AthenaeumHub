package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MvcResult;

import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.support.IntegrationTestBase;

@ActiveProfiles("test")
class SecurityIT extends IntegrationTestBase {

    @Test
    void missingTokenReturns401WithErrorEnvelope() throws Exception {
        MvcResult result = mockMvc.perform(get("/api/v1/sync")
                        .param("workspace_id", UUID.randomUUID().toString())
                        .header("X-Device-Id", UUID.randomUUID().toString()))
                .andExpect(status().isUnauthorized())
                .andReturn();
        assertError(result, "UNAUTHENTICATED");
    }

    @Test
    void missingDeviceHeaderReturns401() throws Exception {
        SessionResponse session = devSession();
        MvcResult result = mockMvc.perform(get("/api/v1/workspaces/{id}/chats", session.workspace().id())
                        .header("Authorization", "Bearer " + session.accessToken()))
                .andExpect(status().isUnauthorized())
                .andReturn();
        assertError(result, "UNAUTHENTICATED");
    }

    @Test
    void mismatchedDeviceHeaderReturns401() throws Exception {
        SessionResponse session = devSession();
        MvcResult result = mockMvc.perform(get("/api/v1/workspaces/{id}/chats", session.workspace().id())
                        .header("Authorization", "Bearer " + session.accessToken())
                        .header("X-Device-Id", UUID.randomUUID().toString()))
                .andExpect(status().isUnauthorized())
                .andReturn();
        assertError(result, "UNAUTHENTICATED");
        assertThat(json(result).get("message").asText()).contains("X-Device-Id");
    }

    @Test
    void garbageTokenReturns401() throws Exception {
        MvcResult result = mockMvc.perform(get("/api/v1/sync")
                        .param("workspace_id", UUID.randomUUID().toString())
                        .header("Authorization", "Bearer not-a-jwt")
                        .header("X-Device-Id", UUID.randomUUID().toString()))
                .andExpect(status().isUnauthorized())
                .andReturn();
        assertError(result, "UNAUTHENTICATED");
    }

    @Test
    void tamperedSignatureReturns401() throws Exception {
        SessionResponse session = devSession();
        String token = session.accessToken();
        String tampered = token.substring(0, token.length() - 3) + "abc";
        mockMvc.perform(get("/api/v1/workspaces/{id}/chats", session.workspace().id())
                        .header("Authorization", "Bearer " + tampered)
                        .header("X-Device-Id", session.device().id().toString()))
                .andExpect(status().isUnauthorized());
    }

    private void assertError(MvcResult result, String code) throws Exception {
        JsonNode body = json(result);
        assertThat(body.get("code").asText()).isEqualTo(code);
        assertThat(body.get("message").asText()).isNotBlank();
        assertThat(body.has("details")).isTrue();
        assertThat(body.get("request_id").asText()).isNotBlank();
        assertThat(result.getResponse().getHeader("X-Request-Id")).isNotBlank();
    }
}
