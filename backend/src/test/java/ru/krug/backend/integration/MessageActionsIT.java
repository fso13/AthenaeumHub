package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.net.URI;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.DataAccessException;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MvcResult;

import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.shared.application.model.IssuedToken;
import ru.krug.backend.shared.application.port.TokenIssuer;
import ru.krug.backend.support.IntegrationTestBase;
import ru.krug.backend.support.OpenApiContract;
import ru.krug.backend.support.StickerTestSupport;

/**
 * Issues #61-#63: reactions, edit and delete over the real REST/DB stack.
 *
 * <p>Covers idempotency, aggregation, permissions, validation, tombstone semantics,
 * per-user visibility, RLS and the migrated schema.
 */
@ActiveProfiles("test")
class MessageActionsIT extends IntegrationTestBase {

    private static final OpenApiContract CONTRACT = OpenApiContract.load();
    private static final String THUMB = "\uD83D\uDC4D"; // 👍
    private static final String HEART = "\u2764\uFE0F"; // ❤️

    @Autowired
    private TokenIssuer tokenIssuer;

    @Test
    void reactionsAreUniqueAggregatedAndCallerRelative() throws Exception {
        SessionResponse alice = devSession();
        SessionResponse bob = devSession();
        joinWorkspace(alice, bob);
        joinChat(alice, bob);
        SessionResponse bobInChat = scoped(bob, alice);
        UUID chatId = alice.chat().id();
        UUID messageId = UUID.fromString(sendMessage(alice, chatId,
                UUID.randomUUID().toString(), UUID.randomUUID().toString(), "react to me")
                .get("id").asText());

        JsonNode first = react(alice, chatId, messageId, THUMB, 200);
        CONTRACT.assertValid("ReactionSummary", first);
        assertThat(first.get("emoji").asText()).isEqualTo(THUMB);
        assertThat(first.get("count").asInt()).isEqualTo(1);
        assertThat(first.get("me").asBoolean()).isTrue();

        // Idempotent add: the PK prevents a duplicate row and the aggregate stays 1.
        JsonNode repeated = react(alice, chatId, messageId, THUMB, 200);
        assertThat(repeated.get("count").asInt()).isEqualTo(1);
        assertThat(dataCount("SELECT count(*) FROM message.message_reactions WHERE message_id = ?", messageId)).isEqualTo(1);

        JsonNode fromBob = react(bobInChat, chatId, messageId, THUMB, 200);
        assertThat(fromBob.get("count").asInt()).isEqualTo(2);
        assertThat(fromBob.get("me").asBoolean()).isTrue();
        react(bobInChat, chatId, messageId, HEART, 200);

        JsonNode alicePage = messages(alice, chatId);
        JsonNode aliceMessage = item(alicePage, messageId);
        CONTRACT.assertValid("Message", aliceMessage);
        assertThat(aliceMessage.get("reactions").size()).isEqualTo(2);
        JsonNode thumbForAlice = reaction(aliceMessage, THUMB);
        assertThat(thumbForAlice.get("count").asInt()).isEqualTo(2);
        assertThat(thumbForAlice.get("me").asBoolean()).isTrue();
        assertThat(reaction(aliceMessage, HEART).get("me").asBoolean()).isFalse();

        JsonNode bobPage = messages(bobInChat, chatId);
        JsonNode bobMessage = item(bobPage, messageId);
        assertThat(reaction(bobMessage, HEART).get("me").asBoolean()).isTrue();

        assertThat(unreact(alice, chatId, messageId, THUMB).getResponse().getStatus())
                .isEqualTo(204);
        assertThat(reaction(item(messages(alice, chatId), messageId), THUMB).get("count").asInt())
                .isEqualTo(1);
        assertThat(reaction(item(messages(alice, chatId), messageId), THUMB).get("me").asBoolean())
                .isFalse();
        // Removing a non-existent reaction is still 204.
        assertThat(unreact(alice, chatId, messageId, THUMB).getResponse().getStatus())
                .isEqualTo(204);

        // Invalid emoji values are rejected before any write.
        react(alice, chatId, messageId, "abc", 422);
        react(alice, chatId, messageId, "<b>", 422);
        react(alice, chatId, messageId, "😀".repeat(9), 422);
        assertThat(dataCount("SELECT count(*) FROM message.message_reactions WHERE message_id = ?", messageId)).isEqualTo(2);

        // Unknown/foreign message is hidden as 404.
        react(alice, chatId, UUID.randomUUID(), THUMB, 404);
        react(alice, bob.chat().id(), messageId, THUMB, 404);
    }

    @Test
    void editOwnManagedTextWithValidationVersionAndContract() throws Exception {
        SessionResponse alice = devSession();
        SessionResponse bob = devSession();
        joinWorkspace(alice, bob);
        joinChat(alice, bob);
        SessionResponse bobInChat = scoped(bob, alice);
        UUID chatId = alice.chat().id();
        JsonNode sent = sendMessage(alice, chatId, UUID.randomUUID().toString(),
                UUID.randomUUID().toString(), "before");
        UUID messageId = UUID.fromString(sent.get("id").asText());

        MvcResult edited = edit(alice, chatId, messageId, "after", null);
        assertThat(edited.getResponse().getStatus()).isEqualTo(200);
        JsonNode body = json(edited);
        CONTRACT.assertValid("Message", body);
        assertThat(body.get("text").asText()).isEqualTo("after");
        assertThat(body.get("version").asInt()).isEqualTo(2);
        assertThat(body.get("edited_at").isNull()).isFalse();
        assertThat(body.get("seq").asLong()).isEqualTo(sent.get("seq").asLong());
        assertThat(body.get("reactions").size()).isZero();

        // Optimistic lock: stale version is a typed 409 and changes nothing.
        MvcResult stale = edit(alice, chatId, messageId, "stale", 1);
        assertThat(stale.getResponse().getStatus()).isEqualTo(409);
        assertThat(json(stale).get("code").asText()).isEqualTo("VERSION_CONFLICT");

        // Correct version works and increments again.
        MvcResult second = edit(alice, chatId, messageId, "final", 2);
        assertThat(second.getResponse().getStatus()).isEqualTo(200);
        assertThat(json(second).get("version").asInt()).isEqualTo(3);

        JsonNode page = messages(alice, chatId);
        assertThat(item(page, messageId).get("text").asText()).isEqualTo("final");
        assertThat(item(page, messageId).get("version").asInt()).isEqualTo(3);

        // Only the sender may edit.
        MvcResult foreign = edit(bobInChat, chatId, messageId, "hijack", null);
        assertThat(foreign.getResponse().getStatus()).isEqualTo(403);

        // Empty/oversized text is rejected.
        MvcResult blank = edit(alice, chatId, messageId, "   ", null);
        assertThat(blank.getResponse().getStatus()).isEqualTo(422);
        assertThat(json(blank).get("details").get("field").asText()).isEqualTo("text");
        MvcResult huge = edit(alice, chatId, messageId, "x".repeat(8001), null);
        assertThat(huge.getResponse().getStatus()).isEqualTo(422);
        assertThat(json(huge).get("code").asText()).isEqualTo("MESSAGE_TOO_LONG");

        // Sticker/system rows are not editable.
        MvcResult sticker = sendSticker(alice, chatId, StickerTestSupport.KRUG_01,
                UUID.randomUUID().toString(), UUID.randomUUID().toString());
        assertThat(sticker.getResponse().getStatus()).isEqualTo(201);
        UUID stickerId = UUID.fromString(json(sticker).get("id").asText());
        MvcResult stickerEdit = edit(alice, chatId, stickerId, "nope", null);
        assertThat(stickerEdit.getResponse().getStatus()).isEqualTo(422);
        assertThat(json(stickerEdit).get("code").asText()).isEqualTo("MESSAGE_NOT_EDITABLE");

        // Unknown message/chat is hidden as 404.
        assertThat(edit(alice, chatId, UUID.randomUUID(), "nope", null)
                .getResponse().getStatus()).isEqualTo(404);
        assertThat(edit(alice, bob.chat().id(), messageId, "nope", null)
                .getResponse().getStatus()).isEqualTo(404);
    }

    @Test
    void deleteForMeHidesOnlyForTheCallerAndIsIdempotent() throws Exception {
        SessionResponse alice = devSession();
        SessionResponse bob = devSession();
        joinWorkspace(alice, bob);
        joinChat(alice, bob);
        SessionResponse bobInChat = scoped(bob, alice);
        UUID chatId = alice.chat().id();
        JsonNode sent = sendMessage(alice, chatId, UUID.randomUUID().toString(),
                UUID.randomUUID().toString(), "private-for-me");
        UUID messageId = UUID.fromString(sent.get("id").asText());

        assertThat(deleteMessage(alice, chatId, messageId, "me").getResponse().getStatus())
                .isEqualTo(204);
        assertThat(messages(alice, chatId).get("items").size()).isZero();
        JsonNode bobPage = messages(bobInChat, chatId);
        assertThat(bobPage.get("items").size()).isEqualTo(1);
        assertThat(item(bobPage, messageId).get("text").asText()).isEqualTo("private-for-me");

        // The message and its content are untouched for everyone else.
        assertThat(dataCount("SELECT count(*) FROM message.messages WHERE chat_id = ?", chatId)).isEqualTo(1);
        assertThat(dataCount("SELECT count(*) FROM message.message_deletions WHERE message_id = ?", messageId)).isEqualTo(1);
        Map<String, Object> row = migrator().queryForMap("""
                SELECT deleted_at, body_ciphertext FROM message.messages WHERE id = ?
                """, messageId);
        assertThat(row.get("deleted_at")).isNull();
        assertThat(row.get("body_ciphertext")).isNotNull();

        // Repeat is a no-op (first timestamp wins).
        assertThat(deleteMessage(alice, chatId, messageId, "me").getResponse().getStatus())
                .isEqualTo(204);
        assertThat(dataCount("SELECT count(*) FROM message.message_deletions WHERE message_id = ?", messageId)).isEqualTo(1);

        // Hidden for the caller: reaction/edit/reply semantics treat it as absent.
        react(alice, chatId, messageId, THUMB, 404);

        // Bob hides it too; both timelines are empty, the row still exists.
        assertThat(deleteMessage(bobInChat, chatId, messageId, "me").getResponse().getStatus())
                .isEqualTo(204);
        assertThat(messages(bobInChat, chatId).get("items").size()).isZero();
        assertThat(dataCount("SELECT count(*) FROM message.messages WHERE chat_id = ?", chatId)).isEqualTo(1);
    }

    @Test
    void deleteForAllIsSenderOnlySoftAndIdempotent() throws Exception {
        SessionResponse alice = devSession();
        SessionResponse bob = devSession();
        joinWorkspace(alice, bob);
        joinChat(alice, bob);
        SessionResponse bobInChat = scoped(bob, alice);
        UUID chatId = alice.chat().id();
        JsonNode sent = sendMessage(alice, chatId, UUID.randomUUID().toString(),
                UUID.randomUUID().toString(), "delete me for all");
        UUID messageId = UUID.fromString(sent.get("id").asText());
        react(bobInChat, chatId, messageId, THUMB, 200);

        // Only the sender may tombstone the row.
        assertThat(deleteMessage(bobInChat, chatId, messageId, "all").getResponse().getStatus())
                .isEqualTo(403);
        assertThat(dataCount("SELECT count(*) FROM message.message_reactions WHERE message_id = ?", messageId)).isEqualTo(1);

        assertThat(deleteMessage(alice, chatId, messageId, "all").getResponse().getStatus())
                .isEqualTo(204);
        Map<String, Object> row = migrator().queryForMap("""
                SELECT deleted_at, deleted_by, body_ciphertext, content_meta::text AS meta, version,
                       (SELECT count(*) FROM message.message_reactions r
                         WHERE r.message_id = message.messages.id) AS reactions
                  FROM message.messages WHERE id = ?
                """, messageId);
        assertThat(row.get("deleted_at")).isNotNull();
        assertThat(row.get("deleted_by")).isEqualTo(alice.user().id());
        assertThat(row.get("body_ciphertext")).isNull();
        assertThat(row.get("meta")).isEqualTo("{}");
        assertThat(row.get("reactions")).isEqualTo(0L);

        JsonNode bobPage = messages(bobInChat, chatId);
        JsonNode tombstone = item(bobPage, messageId);
        CONTRACT.assertValid("Message", tombstone);
        assertThat(tombstone.get("text").isNull()).isTrue();
        assertThat(tombstone.get("deleted_at").isNull()).isFalse();
        assertThat(tombstone.get("reactions").size()).isZero();
        assertThat(tombstone.get("attachments").size()).isZero();
        assertThat(tombstone.get("thread_summary").isNull()).isTrue();
        assertThat(tombstone.get("seq").asLong()).isEqualTo(sent.get("seq").asLong());

        JsonNode aliceTombstone = item(messages(alice, chatId), messageId);
        assertThat(aliceTombstone.get("text").isNull()).isTrue();

        // Idempotent 204: no new version, no new event/fact.
        assertThat(deleteMessage(alice, chatId, messageId, "all").getResponse().getStatus())
                .isEqualTo(204);
        assertThat(migrator().queryForObject(
                "SELECT version FROM message.messages WHERE id = ?", Integer.class, messageId))
                .isEqualTo(((Number) row.get("version")).intValue());

        // A tombstone cannot be edited or reacted to.
        assertThat(edit(alice, chatId, messageId, "resurrect", null).getResponse().getStatus())
                .isEqualTo(404);
        react(bobInChat, chatId, messageId, THUMB, 404);

        // Delete-for-me on an already-global tombstone is still harmless.
        assertThat(deleteMessage(bobInChat, chatId, messageId, "me").getResponse().getStatus())
                .isEqualTo(204);
        assertThat(messages(bobInChat, chatId).get("items").size()).isZero();
    }

    @Test
    void invalidScopeAndForeignChatAreRejected() throws Exception {
        SessionResponse alice = devSession();
        UUID messageId = UUID.fromString(sendMessage(alice, alice.chat().id(),
                UUID.randomUUID().toString(), UUID.randomUUID().toString(), "scope")
                .get("id").asText());
        MvcResult invalid = deleteMessage(alice, alice.chat().id(), messageId, "everyone");
        assertThat(invalid.getResponse().getStatus()).isEqualTo(400);
        assertThat(json(invalid).get("code").asText()).isEqualTo("VALIDATION_FAILED");
        assertThat(deleteMessage(alice, UUID.randomUUID(), messageId, "me")
                .getResponse().getStatus()).isEqualTo(404);
    }

    @Test
    void schemaIndexesRlsAndGrantsBackTheActions() throws Exception {
        assertThat(migrationCount("""
                SELECT count(*) FROM information_schema.columns
                 WHERE table_schema = 'message' AND table_name = 'message_reactions'
                   AND column_name IN ('message_id', 'workspace_id', 'chat_id', 'user_id',
                                       'emoji', 'created_at')
                """)).isEqualTo(6);
        assertThat(migrationCount("""
                SELECT count(*) FROM information_schema.columns
                 WHERE table_schema = 'message' AND table_name = 'message_deletions'
                   AND column_name IN ('message_id', 'workspace_id', 'chat_id', 'user_id',
                                       'deleted_at')
                """)).isEqualTo(5);
        assertThat(migrationCount("""
                SELECT count(*) FROM pg_constraint
                 WHERE conrelid = 'message.message_reactions'::regclass
                   AND conname IN ('ck_message_reactions_emoji_length',
                                   'ck_message_reactions_emoji_chars')
                """)).isEqualTo(2);
        assertThat(migrationCount("""
                SELECT count(*) FROM pg_indexes
                 WHERE schemaname = 'message'
                   AND indexname IN ('ix_message_reactions_ws_message',
                                     'ix_message_reactions_ws_chat',
                                     'ix_message_deletions_ws_user_message')
                """)).isEqualTo(3);
        for (String table : List.of("message.message_reactions", "message.message_deletions")) {
            Map<String, Object> flags = jdbc.queryForMap("""
                    SELECT relrowsecurity, relforcerowsecurity
                      FROM pg_class WHERE oid = ?::regclass
                    """, table);
            assertThat(flags.get("relrowsecurity")).as(table).isEqualTo(true);
            assertThat(flags.get("relforcerowsecurity")).as(table).isEqualTo(true);
            assertThat(migrationCount("SELECT count(*) FROM information_schema.role_table_grants"
                    + " WHERE table_schema = 'message' AND table_name = '"
                    + table.substring("message.".length()) + "' AND grantee = 'krug_app'"))
                    .isGreaterThanOrEqualTo(2);
        }
        assertThat(migrationCount("""
                SELECT count(*) FROM pg_policies
                 WHERE schemaname = 'message'
                   AND policyname IN ('p_message_reactions_tenant', 'p_message_deletions_tenant')
                """)).isEqualTo(2);
        assertThat(migrationCount("""
                SELECT count(*) FROM information_schema.columns
                 WHERE table_schema = 'message' AND table_name = 'messages'
                   AND column_name = 'edited_at'
                """)).isEqualTo(1);

        SessionResponse alice = devSession();
        SessionResponse bob = devSession();
        UUID chatId = alice.chat().id();
        UUID messageId = UUID.fromString(sendMessage(alice, chatId,
                UUID.randomUUID().toString(), UUID.randomUUID().toString(), "rls")
                .get("id").asText());
        react(alice, chatId, messageId, THUMB, 200);

        // The runtime role in Alice's tenant sees only Alice's reaction row.
        assertThat(inTenant(alice.user().id(), alice.workspace().id(),
                () -> jdbc.queryForObject("SELECT count(*) FROM message.message_reactions",
                        Integer.class))).isEqualTo(1);
        assertThat(inTenant(alice.user().id(), bob.workspace().id(),
                () -> jdbc.queryForObject("SELECT count(*) FROM message.message_reactions",
                        Integer.class))).isZero();

        // A forged workspace_id is rejected by the WITH CHECK policy, not stored.
        assertThatThrownBy(() -> inTenant(alice.user().id(), alice.workspace().id(),
                () -> jdbc.update("""
                        INSERT INTO message.message_reactions
                               (message_id, workspace_id, chat_id, user_id, emoji)
                        VALUES (?, ?, ?, ?, ?)
                        """, messageId, bob.workspace().id(), bob.chat().id(),
                        alice.user().id(), THUMB)))
                .isInstanceOf(DataAccessException.class);
        // The DB check constraints reject markup/control/oversized emoji as a backstop.
        assertThatThrownBy(() -> inTenant(alice.user().id(), alice.workspace().id(),
                () -> jdbc.update("""
                        INSERT INTO message.message_reactions
                               (message_id, workspace_id, chat_id, user_id, emoji)
                        VALUES (?, ?, ?, ?, '<b>')
                        """, messageId, alice.workspace().id(), chatId,
                        bob.user().id())))
                .isInstanceOf(DataAccessException.class);
        // And message_deletions cannot be written into another tenant.
        assertThatThrownBy(() -> inTenant(alice.user().id(), alice.workspace().id(),
                () -> jdbc.update("""
                        INSERT INTO message.message_deletions
                               (message_id, workspace_id, chat_id, user_id)
                        VALUES (?, ?, ?, ?)
                        """, messageId, bob.workspace().id(), bob.chat().id(),
                        alice.user().id())))
                .isInstanceOf(DataAccessException.class);
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    private SessionResponse scoped(SessionResponse user, SessionResponse resource) {
        IssuedToken token = tokenIssuer.issue(user.user().id(), user.device().id(),
                resource.workspace().id());
        return new SessionResponse(token.accessToken(), token.expiresAt(), user.user(),
                user.device(), resource.workspace(), resource.chat());
    }

    private void joinWorkspace(SessionResponse owner, SessionResponse member) {
        migrator().update("""
                INSERT INTO workspace.memberships (workspace_id, user_id, role, status)
                VALUES (?, ?, 'MEMBER', 'ACTIVE')
                ON CONFLICT (workspace_id, user_id) DO UPDATE SET status = 'ACTIVE'
                """, owner.workspace().id(), member.user().id());
    }

    private void joinChat(SessionResponse owner, SessionResponse member) {
        migrator().update("""
                INSERT INTO chat.chat_members (chat_id, workspace_id, user_id, role, status)
                VALUES (?, ?, ?, 'MEMBER', 'ACTIVE')
                ON CONFLICT (chat_id, user_id) DO UPDATE SET status = 'ACTIVE'
                """, owner.chat().id(), owner.workspace().id(), member.user().id());
    }

    private JsonNode messages(SessionResponse session, UUID chatId) throws Exception {
        MvcResult result = mockMvc.perform(authed(
                        get("/api/v1/chats/{chatId}/messages", chatId), session))
                .andExpect(status().isOk())
                .andReturn();
        return json(result);
    }

    private static JsonNode item(JsonNode page, UUID messageId) {
        for (JsonNode item : page.get("items")) {
            if (messageId.toString().equals(item.get("id").asText())) {
                return item;
            }
        }
        throw new AssertionError("message " + messageId + " not found in " + page);
    }

    private static JsonNode reaction(JsonNode message, String emoji) {
        for (JsonNode item : message.get("reactions")) {
            if (emoji.equals(item.get("emoji").asText())) {
                return item;
            }
        }
        throw new AssertionError("reaction " + emoji + " not found in " + message);
    }

    private JsonNode react(SessionResponse session, UUID chatId, UUID messageId, String emoji,
                           int expectedStatus) throws Exception {
        MvcResult result = mockMvc.perform(authed(
                        post("/api/v1/chats/{chatId}/messages/{messageId}/reactions",
                                chatId, messageId), session)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("emoji", emoji))))
                .andReturn();
        assertThat(result.getResponse().getStatus()).isEqualTo(expectedStatus);
        return json(result);
    }

    private MvcResult unreact(SessionResponse session, UUID chatId, UUID messageId,
                              String emoji) throws Exception {
        String path = "/api/v1/chats/" + chatId + "/messages/" + messageId
                + "/reactions/" + URLEncoder.encode(emoji, StandardCharsets.UTF_8);
        return mockMvc.perform(authed(delete(URI.create(path)), session)).andReturn();
    }

    private MvcResult edit(SessionResponse session, UUID chatId, UUID messageId, String text,
                           Integer version) throws Exception {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("text", text);
        if (version != null) {
            body.put("version", version);
        }
        return mockMvc.perform(authed(
                        patch("/api/v1/chats/{chatId}/messages/{messageId}", chatId, messageId),
                        session)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(body)))
                .andReturn();
    }

    private MvcResult deleteMessage(SessionResponse session, UUID chatId, UUID messageId,
                                    String scope) throws Exception {
        return mockMvc.perform(authed(delete(
                        "/api/v1/chats/{chatId}/messages/{messageId}", chatId, messageId)
                        .param("scope", scope), session))
                .andReturn();
    }

    private long migrationCount(String sql) {
        Long value = jdbc.queryForObject(sql, Long.class);
        return value == null ? 0 : value;
    }

    /** Data assertions bypass RLS through the migrator connection (like other ITs). */
    private long dataCount(String sql, Object... args) {
        Long value = migrator().queryForObject(sql, Long.class, args);
        return value == null ? 0 : value;
    }
}
