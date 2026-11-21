package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import java.util.List;
import java.util.Map;
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

/**
 * #96: bot sends have an independent per-bot window. A rejected send rolls back its
 * Idempotency-Key reservation, and a replay of a committed send does not consume quota.
 */
@SpringBootTest(properties = {
        "krug.rate-limit.bot-send-per-bot=2",
        "krug.rate-limit.bot-send-per-chat=10000",
        "krug.rate-limit.bot-send-window=60s"
})
@AutoConfigureMockMvc
@ActiveProfiles("test")
class BotRateLimitIT extends IntegrationTestBase {

    @Test
    void thirdBotSendIsRateLimitedAndReplayStillWorks() throws Exception {
        SessionResponse owner = devSession();
        UUID workspaceId = owner.workspace().id();
        UUID chatId = owner.chat().id();

        MvcResult created = mockMvc.perform(authed(
                        post("/api/v1/workspaces/{workspaceId}/bots", workspaceId), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "name", "Rate Bot", "scopes", List.of("chat.write")))))
                .andReturn();
        assertThat(created.getResponse().getStatus()).isEqualTo(201);
        JsonNode bot = json(created);
        String botId = bot.get("bot").get("id").asText();
        String token = bot.get("token").asText();

        MvcResult installed = mockMvc.perform(authed(
                        post("/api/v1/chats/{chatId}/bots", chatId), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("bot_id", botId))))
                .andReturn();
        assertThat(installed.getResponse().getStatus()).isEqualTo(201);

        String firstKey = UUID.randomUUID().toString();
        assertThat(send(token, botId, chatId, firstKey, "one").getResponse().getStatus())
                .isEqualTo(201);
        assertThat(send(token, botId, chatId, UUID.randomUUID().toString(), "two")
                .getResponse().getStatus()).isEqualTo(201);

        MvcResult limited = send(token, botId, chatId, UUID.randomUUID().toString(), "three");
        assertThat(limited.getResponse().getStatus()).isEqualTo(429);
        JsonNode error = json(limited);
        assertThat(error.get("code").asText()).isEqualTo("RATE_LIMITED");
        assertThat(error.get("details").get("scope").asText()).isEqualTo("bot");
        assertThat(limited.getResponse().getHeader("Retry-After")).isNotBlank();

        // A committed replay still returns the original message without consuming quota.
        MvcResult replay = send(token, botId, chatId, firstKey, "one");
        assertThat(replay.getResponse().getStatus()).isEqualTo(201);
        assertThat(replay.getResponse().getHeader("Idempotent-Replay")).isEqualTo("true");
    }

    private MvcResult send(String token, String botId, UUID chatId, String key, String text)
            throws Exception {
        return mockMvc.perform(post("/api/v1/bots/{botId}/messages", botId)
                        .header("Authorization", "Bearer " + token)
                        .header("Idempotency-Key", key)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "chat_id", chatId, "text", text))))
                .andReturn();
    }
}
