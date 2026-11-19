package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MvcResult;

import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.support.IntegrationTestBase;
import ru.krug.backend.support.OpenApiContract;
import ru.krug.backend.support.StickerTestSupport;

@ActiveProfiles("test")
class StickerPackIT extends IntegrationTestBase {

    private static final OpenApiContract CONTRACT = OpenApiContract.load();

    @Test
    void listsBuiltInPacksWithAltUrlsAndActiveStickers() throws Exception {
        SessionResponse session = devSession();

        MvcResult result = mockMvc.perform(authed(
                        get("/api/v1/sticker-packs")
                                .param("chat_id", session.chat().id().toString()), session))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode body = json(result);
        CONTRACT.assertValid("StickerPackList", body);

        assertThat(body.get("items").size()).isEqualTo(2);
        JsonNode krug = pack(body, "Сова");
        JsonNode cats = pack(body, "Коты");
        assertThat(krug.get("id").asText()).isEqualTo(StickerTestSupport.KRUG_PACK_ID.toString());
        assertThat(krug.get("cover_url").asText()).isEqualTo("/stickers/krug/cover.png");
        assertThat(cats.get("id").asText()).isEqualTo(StickerTestSupport.CATS_PACK_ID.toString());
        assertThat(cats.get("cover_url").asText()).isEqualTo("/stickers/cats/cover.png");

        assertThat(krug.get("stickers").size()).isEqualTo(8);
        assertThat(cats.get("stickers").size()).isEqualTo(8);
        JsonNode first = krug.get("stickers").get(0);
        assertThat(first.get("id").asText()).isEqualTo(StickerTestSupport.KRUG_01.toString());
        assertThat(first.get("pack_id").asText()).isEqualTo(StickerTestSupport.KRUG_PACK_ID.toString());
        assertThat(first.get("alt").asText()).isEqualTo("Сова — стикер 1");
        assertThat(first.get("url").asText()).isEqualTo("/stickers/krug/01.png");
        assertThat(first.get("favorite").asBoolean()).isFalse();
        assertThat(krug.get("stickers").get(7).get("url").asText())
                .isEqualTo("/stickers/krug/08.png");

        // V14: exactly 2 built-in ACTIVE packs x 8 PNG 512x512 <= 512 KiB.
        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM sticker.sticker_packs
                 WHERE builtin AND status = 'ACTIVE'
                """, Integer.class)).isEqualTo(2);
        List<Map<String, Object>> counts = migrator().queryForList("""
                SELECT pack_id, count(*) AS stickers FROM sticker.stickers
                 WHERE status = 'ACTIVE' GROUP BY pack_id
                """);
        assertThat(counts).hasSize(2);
        assertThat(counts).allSatisfy(row -> assertThat(((Number) row.get("stickers")).intValue())
                .isEqualTo(8));
        Integer invalid = migrator().queryForObject("""
                SELECT count(*) FROM sticker.stickers
                 WHERE format <> 'PNG' OR width <> 512 OR height <> 512
                    OR size_bytes <= 0 OR size_bytes > 524288
                """, Integer.class);
        assertThat(invalid).isZero();
    }

    @Test
    void favoriteAndUnfavoriteAreIdempotentAndPerUser() throws Exception {
        SessionResponse alice = devSession();
        SessionResponse bob = devSession();

        favorite(alice, StickerTestSupport.KRUG_01).andExpect(status().isNoContent());
        favorite(alice, StickerTestSupport.KRUG_01).andExpect(status().isNoContent());

        JsonNode alicePacks = stickerPacks(alice, alice.chat().id());
        assertThat(sticker(alicePacks, StickerTestSupport.KRUG_01).get("favorite").asBoolean())
                .isTrue();
        JsonNode bobPacks = stickerPacks(bob, bob.chat().id());
        assertThat(sticker(bobPacks, StickerTestSupport.KRUG_01).get("favorite").asBoolean())
                .isFalse();

        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM sticker.sticker_favorites
                 WHERE user_id = ? AND sticker_id = ?
                """, Integer.class, alice.user().id(), StickerTestSupport.KRUG_01))
                .isEqualTo(1);

        unfavorite(alice, StickerTestSupport.KRUG_01).andExpect(status().isNoContent());
        unfavorite(alice, StickerTestSupport.KRUG_01).andExpect(status().isNoContent());
        assertThat(sticker(stickerPacks(alice, alice.chat().id()),
                StickerTestSupport.KRUG_01).get("favorite").asBoolean()).isFalse();
        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM sticker.sticker_favorites
                 WHERE user_id = ? AND sticker_id = ?
                """, Integer.class, alice.user().id(), StickerTestSupport.KRUG_01)).isZero();
    }

    @Test
    void foreignOrUnknownChatIsHidden() throws Exception {
        SessionResponse alice = devSession();
        SessionResponse bob = devSession();

        mockMvc.perform(authed(get("/api/v1/sticker-packs")
                        .param("chat_id", bob.chat().id().toString()), alice))
                .andExpect(status().isNotFound());

        mockMvc.perform(authed(get("/api/v1/sticker-packs")
                        .param("chat_id", UUID.randomUUID().toString()), alice))
                .andExpect(status().isNotFound());

        mockMvc.perform(authed(get("/api/v1/sticker-packs"), alice))
                .andExpect(status().isBadRequest());
        mockMvc.perform(authed(get("/api/v1/sticker-packs")
                        .param("chat_id", "not-a-uuid"), alice))
                .andExpect(status().isBadRequest());
    }

    @Test
    void unknownInactiveOrDisabledFavoriteIs404() throws Exception {
        SessionResponse session = devSession();

        MvcResult unknown = favorite(session, UUID.randomUUID())
                .andExpect(status().isNotFound()).andReturn();
        assertThat(json(unknown).get("code").asText()).isEqualTo("STICKER_NOT_FOUND");
        unfavorite(session, UUID.randomUUID()).andExpect(status().isNotFound());

        try {
            migrator().update("UPDATE sticker.stickers SET status = 'DISABLED' WHERE id = ?",
                    StickerTestSupport.KRUG_01);
            MvcResult disabledSticker = favorite(session, StickerTestSupport.KRUG_01)
                    .andExpect(status().isNotFound()).andReturn();
            assertThat(json(disabledSticker).get("code").asText())
                    .isEqualTo("STICKER_NOT_FOUND");
            assertThat(sticker(stickerPacks(session, session.chat().id()),
                    StickerTestSupport.KRUG_01)).isNull();
        } finally {
            migrator().update("UPDATE sticker.stickers SET status = 'ACTIVE' WHERE id = ?",
                    StickerTestSupport.KRUG_01);
        }

        try {
            migrator().update("UPDATE sticker.sticker_packs SET status = 'DISABLED' WHERE id = ?",
                    StickerTestSupport.KRUG_PACK_ID);
            favorite(session, StickerTestSupport.KRUG_01).andExpect(status().isNotFound());
            assertThat(pack(stickerPacks(session, session.chat().id()), "Сова")).isNull();
        } finally {
            migrator().update("UPDATE sticker.sticker_packs SET status = 'ACTIVE' WHERE id = ?",
                    StickerTestSupport.KRUG_PACK_ID);
        }
    }

    @Test
    void disabledPackIsHiddenFromPickerButHistoryStillRenders() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();
        MvcResult sent = sendSticker(session, chatId, StickerTestSupport.KRUG_01,
                UUID.randomUUID().toString(), UUID.randomUUID().toString());
        assertThat(sent.getResponse().getStatus())
                .as(sent.getResponse().getContentAsString()).isEqualTo(201);

        try {
            migrator().update("UPDATE sticker.sticker_packs SET status = 'DISABLED' WHERE id = ?",
                    StickerTestSupport.KRUG_PACK_ID);
            JsonNode packs = stickerPacks(session, chatId);
            assertThat(packs.get("items").size()).isEqualTo(1);
            assertThat(pack(packs, "Сова")).isNull();

            MvcResult history = mockMvc.perform(authed(
                            get("/api/v1/chats/{chatId}/messages", chatId), session))
                    .andExpect(status().isOk()).andReturn();
            JsonNode item = json(history).get("items").get(0);
            assertThat(item.get("type").asText()).isEqualTo("STICKER");
            assertThat(item.get("sticker").get("id").asText())
                    .isEqualTo(StickerTestSupport.KRUG_01.toString());
        } finally {
            migrator().update("UPDATE sticker.sticker_packs SET status = 'ACTIVE' WHERE id = ?",
                    StickerTestSupport.KRUG_PACK_ID);
        }
    }

    @Test
    void stickerEndpointsRequireDeviceId() throws Exception {
        SessionResponse session = devSession();
        String bearer = "Bearer " + session.accessToken();

        mockMvc.perform(get("/api/v1/sticker-packs")
                        .param("chat_id", session.chat().id().toString())
                        .header("Authorization", bearer))
                .andExpect(status().isUnauthorized());
        mockMvc.perform(put("/api/v1/stickers/{id}/favorite", StickerTestSupport.KRUG_01)
                        .header("Authorization", bearer))
                .andExpect(status().isUnauthorized());
    }

    private static JsonNode pack(JsonNode list, String name) {
        for (JsonNode item : list.get("items")) {
            if (name.equals(item.get("name").asText())) {
                return item;
            }
        }
        return null;
    }

    private static JsonNode sticker(JsonNode list, UUID stickerId) {
        for (JsonNode pack : list.get("items")) {
            for (JsonNode sticker : pack.get("stickers")) {
                if (stickerId.toString().equals(sticker.get("id").asText())) {
                    return sticker;
                }
            }
        }
        return null;
    }
}
