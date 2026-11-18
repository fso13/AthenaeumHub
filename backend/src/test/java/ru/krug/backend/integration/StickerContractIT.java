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
import ru.krug.backend.support.OpenApiContract;
import ru.krug.backend.support.StickerTestSupport;

/** Strict schema validation of the E5-B endpoints against contracts/openapi.yaml. */
@ActiveProfiles("test")
class StickerContractIT extends IntegrationTestBase {

    private static final OpenApiContract CONTRACT = OpenApiContract.load();

    @Test
    void packListFavoriteAndStickerMessageMatchTheContract() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();

        MvcResult packs = mockMvc.perform(authed(get("/api/v1/sticker-packs")
                        .param("chat_id", chatId.toString()), session))
                .andExpect(status().isOk()).andReturn();
        CONTRACT.assertValid("StickerPackList", json(packs));

        favorite(session, StickerTestSupport.KRUG_01).andExpect(status().isNoContent());

        MvcResult send = sendSticker(session, chatId, StickerTestSupport.KRUG_01,
                UUID.randomUUID().toString(), UUID.randomUUID().toString());
        assertThat(send.getResponse().getStatus()).isEqualTo(201);
        JsonNode stickerMessage = json(send);
        CONTRACT.assertValid("Message", stickerMessage);
        assertThat(stickerMessage.get("type").asText()).isEqualTo("STICKER");
        assertThat(stickerMessage.get("sticker").get("id").asText())
                .isEqualTo(StickerTestSupport.KRUG_01.toString());
        assertThat(stickerMessage.get("sticker").get("favorite").asBoolean()).isTrue();

        MvcResult history = mockMvc.perform(authed(
                        get("/api/v1/chats/{chatId}/messages", chatId), session))
                .andExpect(status().isOk()).andReturn();
        CONTRACT.assertValid("MessagePage", json(history));

        MvcResult packsAfterFavorite = mockMvc.perform(authed(get("/api/v1/sticker-packs")
                        .param("chat_id", chatId.toString()), session))
                .andExpect(status().isOk()).andReturn();
        CONTRACT.assertValid("StickerPackList", json(packsAfterFavorite));

        MvcResult unknown = sendSticker(session, chatId, UUID.randomUUID(),
                UUID.randomUUID().toString(), UUID.randomUUID().toString());
        assertThat(unknown.getResponse().getStatus()).isEqualTo(404);
        CONTRACT.assertValid("Error", json(unknown));
    }
}
