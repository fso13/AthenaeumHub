package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.time.Duration;
import java.time.Instant;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MvcResult;

import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.support.IntegrationTestBase;
import ru.krug.backend.support.OpenApiContract;

@ActiveProfiles("test")
class RealtimeTicketIT extends IntegrationTestBase {

    @Test
    void issuesTicketMatchingOpenApiContractWithThirtySecondTtl() throws Exception {
        SessionResponse session = devSession();

        MvcResult result = mockMvc.perform(authed(post("/api/v1/realtime/ticket"), session))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode body = json(result);
        OpenApiContract.load().assertValid("RealtimeTicket", body);

        assertThat(body.get("ticket").asText()).hasSize(43);
        assertThat(body.get("ws_url").asText()).isEqualTo("ws://localhost:8081/ws");
        Instant expiresAt = Instant.parse(body.get("expires_at").asText());
        Duration ttl = Duration.between(Instant.now(), expiresAt);
        assertThat(ttl).isBetween(Duration.ofSeconds(20), Duration.ofSeconds(40));
    }

    @Test
    void ticketIsNotReturnedWithoutDeviceHeader() throws Exception {
        SessionResponse session = devSession();

        mockMvc.perform(post("/api/v1/realtime/ticket")
                        .header("Authorization", "Bearer " + session.accessToken()))
                .andExpect(status().isUnauthorized());
    }

    @Test
    void ticketForAnotherUsersDeviceIsForbidden() throws Exception {
        SessionResponse first = devSession();
        SessionResponse second = devSession();

        mockMvc.perform(post("/api/v1/realtime/ticket")
                        .header("Authorization", "Bearer " + first.accessToken())
                        .header("X-Device-Id", second.device().id().toString()))
                .andExpect(status().isForbidden());
    }

    @Test
    void unauthenticatedTicketIsRejected() throws Exception {
        mockMvc.perform(post("/api/v1/realtime/ticket"))
                .andExpect(status().isUnauthorized());
    }
}
