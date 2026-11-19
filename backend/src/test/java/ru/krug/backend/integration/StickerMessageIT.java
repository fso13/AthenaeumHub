package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MvcResult;

import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.support.IntegrationTestBase;
import ru.krug.backend.support.OpenApiContract;
import ru.krug.backend.support.StickerTestSupport;

@ActiveProfiles("test")
class StickerMessageIT extends IntegrationTestBase {

    private static final OpenApiContract CONTRACT = OpenApiContract.load();

    @Test
    void sendsStickerMessageWithRenderingMetadataAndReplaysIdempotently() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();
        String clientId = UUID.randomUUID().toString();
        String key = UUID.randomUUID().toString();

        favorite(session, StickerTestSupport.KRUG_01).andExpect(status().isNoContent());

        MvcResult result = sendSticker(session, chatId, StickerTestSupport.KRUG_01, clientId, key);
        assertThat(result.getResponse().getStatus())
                .as(result.getResponse().getContentAsString()).isEqualTo(201);
        JsonNode message = json(result);
        CONTRACT.assertValid("Message", message);
        assertThat(message.get("type").asText()).isEqualTo("STICKER");
        assertThat(message.get("text").isNull()).isTrue();
        assertThat(message.get("attachments").size()).isZero();
        assertThat(message.get("sticker_id").asText())
                .isEqualTo(StickerTestSupport.KRUG_01.toString());
        assertThat(message.get("sticker").get("id").asText())
                .isEqualTo(StickerTestSupport.KRUG_01.toString());
        assertThat(message.get("sticker").get("pack_id").asText())
                .isEqualTo(StickerTestSupport.KRUG_PACK_ID.toString());
        assertThat(message.get("sticker").get("alt").asText()).isEqualTo("Сова — стикер 1");
        assertThat(message.get("sticker").get("url").asText()).isEqualTo("/stickers/krug/01.png");
        assertThat(message.get("sticker").get("favorite").asBoolean()).isTrue();
        assertThat(message.get("seq").asLong()).isEqualTo(1);

        Map<String, Object> stored = migrator().queryForMap("""
                SELECT type, sticker_id, body_ciphertext IS NULL AS no_body
                  FROM message.messages WHERE id = ?::uuid
                """, message.get("id").asText());
        assertThat(stored.get("type")).isEqualTo("STICKER");
        assertThat(stored.get("sticker_id").toString())
                .isEqualTo(StickerTestSupport.KRUG_01.toString());
        assertThat(stored.get("no_body")).isEqualTo(true);

        MvcResult replay = sendSticker(session, chatId, StickerTestSupport.KRUG_01, clientId, key);
        assertThat(replay.getResponse().getStatus()).isEqualTo(201);
        assertThat(replay.getResponse().getHeader("Idempotent-Replay")).isEqualTo("true");
        assertThat(json(replay).get("id").asText()).isEqualTo(message.get("id").asText());
        assertThat(messageCount(chatId)).isEqualTo(1);

        MvcResult reused = sendSticker(session, chatId, StickerTestSupport.KRUG_02,
                UUID.randomUUID().toString(), key);
        assertThat(reused.getResponse().getStatus()).isEqualTo(409);
        assertThat(json(reused).get("code").asText()).isEqualTo("IDEMPOTENCY_KEY_REUSED");

        MvcResult history = mockMvc.perform(authed(
                        get("/api/v1/chats/{chatId}/messages", chatId), session))
                .andExpect(status().isOk()).andReturn();
        JsonNode page = json(history);
        CONTRACT.assertValid("MessagePage", page);
        assertThat(page.get("items").size()).isEqualTo(1);
        assertThat(page.get("items").get(0).get("type").asText()).isEqualTo("STICKER");
        assertThat(page.get("items").get(0).get("sticker").get("id").asText())
                .isEqualTo(StickerTestSupport.KRUG_01.toString());
    }

    @Test
    void stickerMessageKeepsReplyAndSurvivesPackDisable() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();
        JsonNode root = sendMessage(session, chatId, UUID.randomUUID().toString(),
                UUID.randomUUID().toString(), "root");

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("client_message_id", UUID.randomUUID().toString());
        body.put("type", "STICKER");
        body.put("sticker_id", StickerTestSupport.CATS_01.toString());
        body.put("reply_to_id", root.get("id").asText());
        MvcResult sent = postMessage(session, chatId, UUID.randomUUID().toString(), body);
        assertThat(sent.getResponse().getStatus()).isEqualTo(201);
        assertThat(json(sent).get("reply_to_id").asText()).isEqualTo(root.get("id").asText());
        assertThat(json(sent).get("sticker").get("pack_id").asText())
                .isEqualTo(StickerTestSupport.CATS_PACK_ID.toString());

        try {
            migrator().update("UPDATE sticker.sticker_packs SET status = 'DISABLED' WHERE id = ?",
                    StickerTestSupport.CATS_PACK_ID);
            MvcResult history = mockMvc.perform(authed(
                            get("/api/v1/chats/{chatId}/messages", chatId), session))
                    .andExpect(status().isOk()).andReturn();
            JsonNode items = json(history).get("items");
            assertThat(items.get(0).get("sticker").get("id").asText())
                    .isEqualTo(StickerTestSupport.CATS_01.toString());
        } finally {
            migrator().update("UPDATE sticker.sticker_packs SET status = 'ACTIVE' WHERE id = ?",
                    StickerTestSupport.CATS_PACK_ID);
        }
    }

    @Test
    void rejectsMixedIncompleteUnknownAndInactiveStickerPayloads() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();

        MvcResult mixedText = postMessage(session, chatId, UUID.randomUUID().toString(),
                stickerBody(StickerTestSupport.KRUG_01, "text", null));
        assertInvalidSticker(mixedText, 422, "text_not_allowed");

        MvcResult mixedAttachments = postMessage(session, chatId,
                UUID.randomUUID().toString(), stickerBody(StickerTestSupport.KRUG_01, null,
                        List.of(UUID.randomUUID())));
        assertInvalidSticker(mixedAttachments, 422, "attachments_not_allowed");

        MvcResult missingSticker = postMessage(session, chatId, UUID.randomUUID().toString(),
                stickerBody(null, null, null));
        assertInvalidSticker(missingSticker, 422, "missing_sticker_id");

        Map<String, Object> textWithSticker = new LinkedHashMap<>();
        textWithSticker.put("client_message_id", UUID.randomUUID().toString());
        textWithSticker.put("type", "TEXT");
        textWithSticker.put("text", "hello");
        textWithSticker.put("sticker_id", StickerTestSupport.KRUG_01.toString());
        MvcResult textMixed = postMessage(session, chatId, UUID.randomUUID().toString(),
                textWithSticker);
        assertInvalidSticker(textMixed, 422, "mixed_sticker_payload");

        MvcResult unknown = sendSticker(session, chatId, UUID.randomUUID(),
                UUID.randomUUID().toString(), UUID.randomUUID().toString());
        assertThat(unknown.getResponse().getStatus()).isEqualTo(404);
        assertThat(json(unknown).get("code").asText()).isEqualTo("STICKER_NOT_FOUND");

        try {
            migrator().update("UPDATE sticker.stickers SET status = 'DISABLED' WHERE id = ?",
                    StickerTestSupport.KRUG_01);
            MvcResult inactive = sendSticker(session, chatId, StickerTestSupport.KRUG_01,
                    UUID.randomUUID().toString(), UUID.randomUUID().toString());
            assertThat(inactive.getResponse().getStatus()).isEqualTo(410);
            assertThat(json(inactive).get("code").asText()).isEqualTo("STICKER_NOT_FOUND");
        } finally {
            migrator().update("UPDATE sticker.stickers SET status = 'ACTIVE' WHERE id = ?",
                    StickerTestSupport.KRUG_01);
        }

        try {
            migrator().update("UPDATE sticker.sticker_packs SET status = 'DISABLED' WHERE id = ?",
                    StickerTestSupport.KRUG_PACK_ID);
            MvcResult disabledPack = sendSticker(session, chatId, StickerTestSupport.KRUG_01,
                    UUID.randomUUID().toString(), UUID.randomUUID().toString());
            assertThat(disabledPack.getResponse().getStatus()).isEqualTo(409);
            assertThat(json(disabledPack).get("code").asText())
                    .isEqualTo("STICKER_PACK_DISABLED");
        } finally {
            migrator().update("UPDATE sticker.sticker_packs SET status = 'ACTIVE' WHERE id = ?",
                    StickerTestSupport.KRUG_PACK_ID);
        }

        assertThat(messageCount(chatId)).isZero();
    }

    @Test
    void stickerInForeignChatIsHidden() throws Exception {
        SessionResponse alice = devSession();
        SessionResponse bob = devSession();

        MvcResult foreign = sendSticker(bob, alice.chat().id(), StickerTestSupport.KRUG_01,
                UUID.randomUUID().toString(), UUID.randomUUID().toString());
        assertThat(foreign.getResponse().getStatus()).isEqualTo(404);
        assertThat(json(foreign).get("code").asText()).isEqualTo("NOT_FOUND");

        MvcResult unknownChat = sendSticker(alice, UUID.randomUUID(),
                StickerTestSupport.KRUG_01, UUID.randomUUID().toString(),
                UUID.randomUUID().toString());
        assertThat(unknownChat.getResponse().getStatus()).isEqualTo(404);
    }

    private MvcResult postMessage(SessionResponse session, UUID chatId, String key,
                                  Map<String, Object> body) throws Exception {
        return mockMvc.perform(authed(post("/api/v1/chats/{chatId}/messages", chatId), session)
                        .header("Idempotency-Key", key)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(body)))
                .andReturn();
    }

    private static Map<String, Object> stickerBody(UUID stickerId, String text,
                                                   List<UUID> attachments) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("client_message_id", UUID.randomUUID().toString());
        body.put("type", "STICKER");
        if (stickerId != null) {
            body.put("sticker_id", stickerId.toString());
        }
        if (text != null) {
            body.put("text", text);
        }
        if (attachments != null) {
            body.put("attachment_ids", attachments.stream().map(UUID::toString).toList());
        }
        return body;
    }

    private static void assertInvalidSticker(MvcResult result, int status, String reason)
            throws Exception {
        assertThat(result.getResponse().getStatus()).isEqualTo(status);
        JsonNode error = new com.fasterxml.jackson.databind.ObjectMapper()
                .readTree(result.getResponse().getContentAsString());
        assertThat(error.get("code").asText()).isEqualTo("INVALID_STICKER_MESSAGE");
        assertThat(error.get("details").get("reason").asText()).isEqualTo(reason);
    }
}
