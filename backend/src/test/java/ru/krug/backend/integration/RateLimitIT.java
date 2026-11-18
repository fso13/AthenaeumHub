package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MvcResult;

import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.support.IntegrationTestBase;

@SpringBootTest(properties = {
        "krug.rate-limit.send-per-user=2",
        "krug.rate-limit.send-per-chat=10000",
        "krug.rate-limit.send-user-window=60s"
})
@AutoConfigureMockMvc
@ActiveProfiles("test")
class RateLimitIT extends IntegrationTestBase {

    @Test
    void thirdMessageInWindowReturns429AndReplayStillWorks() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();
        String firstKey = UUID.randomUUID().toString();
        String firstClientId = UUID.randomUUID().toString();

        assertThat(send(session, chatId, firstKey, firstClientId, "one").getResponse().getStatus())
                .isEqualTo(201);
        assertThat(send(session, chatId, UUID.randomUUID().toString(),
                UUID.randomUUID().toString(), "two").getResponse().getStatus()).isEqualTo(201);

        MvcResult limited = send(session, chatId, UUID.randomUUID().toString(),
                UUID.randomUUID().toString(), "three");
        assertThat(limited.getResponse().getStatus()).isEqualTo(429);
        JsonNode error = json(limited);
        assertThat(error.get("code").asText()).isEqualTo("RATE_LIMITED");
        assertThat(error.get("details").get("scope").asText()).isEqualTo("user");
        assertThat(limited.getResponse().getHeader("Retry-After")).isNotBlank();
        assertThat(Long.parseLong(limited.getResponse().getHeader("Retry-After")))
                .isGreaterThanOrEqualTo(1);

        // An idempotent replay must not consume the rate limit and returns the original body.
        MvcResult replay = send(session, chatId, firstKey, firstClientId, "one");
        assertThat(replay.getResponse().getStatus()).isEqualTo(201);
        assertThat(replay.getResponse().getHeader("Idempotent-Replay")).isEqualTo("true");
    }

    private MvcResult send(SessionResponse session, UUID chatId, String key, String clientId,
                           String text) throws Exception {
        return mockMvc.perform(authed(post("/api/v1/chats/{chatId}/messages", chatId), session)
                        .header("Idempotency-Key", key)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(messageBody(clientId, text, null)))
                .andReturn();
    }
}
