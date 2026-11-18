package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
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
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

import ru.krug.backend.notification.application.model.MessageCreatedSignal;
import ru.krug.backend.notification.application.usecase.NotificationRetentionService;
import ru.krug.backend.notification.application.usecase.NotifyUseCase;
import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.support.IntegrationTestBase;

/**
 * E6-B end-to-end: post-commit fan-out, no self, dedupe, preferences, E2EE body null,
 * unread/read, cursor pagination, foreign-user behaviour and RLS.
 */
@ActiveProfiles("test")
class NotificationIT extends IntegrationTestBase {

    @Autowired
    private NotifyUseCase notifyUseCase;

    @Autowired
    private NotificationRetentionService notificationRetentionService;

    @Test
    void notifiesOtherActiveMemberButNotSenderAndDeduplicates() throws Exception {
        SessionResponse alice = devSession();
        SessionResponse bob = devSession();
        joinChat(alice, bob);

        JsonNode message = sendMessage(alice, alice.chat().id(), randomKey(),
                UUID.randomUUID().toString(), "привет");

        JsonNode bobPage = list(bob, null, null);
        assertThat(bobPage.get("unread_count").asLong()).isEqualTo(1);
        assertThat(bobPage.get("items").size()).isEqualTo(1);
        JsonNode item = bobPage.get("items").get(0);
        assertThat(item.get("type").asText()).isEqualTo("MESSAGE");
        assertThat(item.get("title").asText()).isEqualTo("Новое сообщение");
        assertThat(item.get("body").isNull()).isTrue();
        assertThat(item.get("chat_id").asText()).isEqualTo(alice.chat().id().toString());
        assertThat(item.get("chat_name").asText()).isEqualTo(alice.chat().name());
        assertThat(item.get("read").asBoolean()).isFalse();
        assertThat(item.get("created_at").asText()).isNotBlank();
        assertThat(bobPage.get("page").get("has_more").asBoolean()).isFalse();
        assertThat(bobPage.get("page").get("next_cursor").isNull()).isTrue();

        JsonNode alicePage = list(alice, null, null);
        assertThat(alicePage.get("items").size()).isZero();
        assertThat(alicePage.get("unread_count").asLong()).isZero();

        MessageCreatedSignal signal = new MessageCreatedSignal(alice.workspace().id(),
                alice.chat().id(), UUID.fromString(message.get("id").asText()),
                alice.user().id(), Instant.parse(message.get("created_at").asText()));
        notifyUseCase.notifyMessageCreated(signal);
        notifyUseCase.notifyMessageCreated(signal);

        assertThat(notificationCount(bob.user().id(), alice.chat().id())).isEqualTo(1);
    }

    @Test
    void unreadCountAndReadOneOrAllAreIdempotent() throws Exception {
        SessionResponse alice = devSession();
        SessionResponse bob = devSession();
        joinChat(alice, bob);
        for (int i = 0; i < 3; i++) {
            sendMessage(alice, alice.chat().id(), randomKey(), UUID.randomUUID().toString(),
                    "msg-" + i);
        }

        JsonNode page = list(bob, null, null);
        assertThat(page.get("unread_count").asLong()).isEqualTo(3);
        List<String> ids = new ArrayList<>();
        page.get("items").forEach(item -> ids.add(item.get("id").asText()));

        markRead(bob, Map.of("ids", List.of(ids.get(0)))).andExpect(status().isNoContent());
        JsonNode afterOne = list(bob, null, null);
        assertThat(afterOne.get("unread_count").asLong()).isEqualTo(2);
        assertThat(findItem(afterOne, ids.get(0)).get("read").asBoolean()).isTrue();

        markRead(bob, Map.of("all", true)).andExpect(status().isNoContent());
        assertThat(list(bob, null, null).get("unread_count").asLong()).isZero();

        // Repeating read-all is a no-op and still returns 204.
        markRead(bob, Map.of("all", true)).andExpect(status().isNoContent());
        assertThat(list(bob, null, null).get("unread_count").asLong()).isZero();
    }

    @Test
    void cursorPaginationIsStableAndHasNoDuplicates() throws Exception {
        SessionResponse alice = devSession();
        SessionResponse bob = devSession();
        joinChat(alice, bob);
        for (int i = 0; i < 3; i++) {
            sendMessage(alice, alice.chat().id(), randomKey(), UUID.randomUUID().toString(),
                    "page-" + i);
        }

        JsonNode first = list(bob, null, 2);
        assertThat(first.get("items").size()).isEqualTo(2);
        assertThat(first.get("page").get("has_more").asBoolean()).isTrue();
        String cursor = first.get("page").get("next_cursor").asText();
        assertThat(cursor).isNotBlank();

        JsonNode second = list(bob, cursor, 2);
        assertThat(second.get("items").size()).isEqualTo(1);
        assertThat(second.get("page").get("has_more").asBoolean()).isFalse();
        assertThat(second.get("page").get("next_cursor").isNull()).isTrue();

        List<String> ids = new ArrayList<>();
        first.get("items").forEach(item -> ids.add(item.get("id").asText()));
        second.get("items").forEach(item -> ids.add(item.get("id").asText()));
        assertThat(ids).doesNotHaveDuplicates().hasSize(3);
    }

    @Test
    void mutePreferencePreventsNotificationCreation() throws Exception {
        SessionResponse alice = devSession();
        SessionResponse bob = devSession();
        joinChat(alice, bob);

        JsonNode patched = patchPreference(bob, Map.of(
                "chat_id", alice.chat().id().toString(),
                "type", "MESSAGE",
                "channel", "IN_APP",
                "mode", "MUTE"));
        assertThat(patched.get("mode").asText()).isEqualTo("MUTE");
        assertThat(patched.get("chat_id").asText()).isEqualTo(alice.chat().id().toString());

        sendMessage(alice, alice.chat().id(), randomKey(), UUID.randomUUID().toString(),
                "muted");

        assertThat(list(bob, null, null).get("items").size()).isZero();
        JsonNode prefs = getPreferences(bob);
        assertThat(prefs.get("items").size()).isEqualTo(1);
        assertThat(prefs.get("items").get(0).get("mode").asText()).isEqualTo("MUTE");
        assertThat(notificationCount(bob.user().id(), alice.chat().id())).isZero();
    }

    @Test
    void e2eeNotificationHasGenericTitleAndNullBody() throws Exception {
        SessionResponse alice = devSession();
        SessionResponse bob = devSession();
        UUID chatId = createChat(alice.workspace().id(), alice.user().id(), "E2EE fixture",
                "E2EE", List.of(alice.user().id(), bob.user().id()));

        // E7-B1: E2EE send is gated (409), so exercise the fan-out signal directly; the
        // notification row must still never contain a body.
        notifyUseCase.notifyMessageCreated(new MessageCreatedSignal(alice.workspace().id(),
                chatId, UUID.randomUUID(), alice.user().id(), Instant.now()));

        JsonNode page = list(bob, null, null);
        assertThat(page.get("items").size()).isEqualTo(1);
        JsonNode item = page.get("items").get(0);
        assertThat(item.get("chat_id").asText()).isEqualTo(chatId.toString());
        assertThat(item.get("chat_name").asText()).isEqualTo("E2EE fixture");
        assertThat(item.get("title").asText()).isEqualTo("Новое сообщение");
        assertThat(item.get("body").isNull()).isTrue();
        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM notification.notifications
                 WHERE user_id = ? AND chat_id = ? AND body IS NOT NULL
                """, Integer.class, bob.user().id(), chatId)).isZero();
    }

    @Test
    void foreignNotificationCannotBeMarkedAndForeignChatPreferenceIsForbidden()
            throws Exception {
        SessionResponse alice = devSession();
        SessionResponse bob = devSession();
        joinChat(alice, bob);
        sendMessage(alice, alice.chat().id(), randomKey(), UUID.randomUUID().toString(), "one");
        String bobNotificationId = list(bob, null, null).get("items").get(0).get("id").asText();

        markRead(alice, Map.of("ids", List.of(bobNotificationId)))
                .andExpect(status().isNoContent());

        JsonNode bobPage = list(bob, null, null);
        assertThat(bobPage.get("unread_count").asLong()).isEqualTo(1);
        assertThat(findItem(bobPage, bobNotificationId).get("read").asBoolean()).isFalse();

        MvcResult foreignPreference = mockMvc.perform(authed(
                        patch("/api/v1/notification-preferences"), alice)
                        .header("Idempotency-Key", randomKey())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "chat_id", bob.chat().id().toString(),
                                "type", "MESSAGE",
                                "channel", "IN_APP",
                                "mode", "MUTE"))))
                .andExpect(status().isForbidden())
                .andReturn();
        assertThat(json(foreignPreference).get("code").asText()).isEqualTo("FORBIDDEN");
        assertThat(getPreferences(alice).get("items").size()).isZero();

        assertThat(inTenant(alice.user().id(), alice.workspace().id(), () ->
                jdbc.queryForObject("SELECT count(*) FROM notification.notifications",
                        Integer.class))).isZero();
        assertThat(inTenant(bob.user().id(), alice.workspace().id(), () ->
                jdbc.queryForObject("SELECT count(*) FROM notification.notifications",
                        Integer.class))).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT count(*) FROM notification.notifications",
                Integer.class)).isZero();

        assertThatThrownBy(() -> inTenant(alice.user().id(), alice.workspace().id(), () ->
                jdbc.update("""
                        INSERT INTO notification.notifications
                               (id, user_id, workspace_id, chat_id, type, title, body,
                                dedupe_key, created_at)
                        VALUES (?, ?, ?, ?, 'MESSAGE', 'Новое сообщение', NULL, ?, now())
                        """, UUID.randomUUID(), bob.user().id(), alice.workspace().id(),
                        alice.chat().id(), "rls-" + UUID.randomUUID())))
                .isInstanceOf(DataAccessException.class);
    }

    @Test
    void validatesReadAndPreferenceInputsWith422() throws Exception {
        SessionResponse bob = devSession();

        read(bob, "{}").andExpect(status().isUnprocessableEntity());
        read(bob, objectMapper.writeValueAsString(Map.of(
                "ids", List.of(UUID.randomUUID().toString()), "all", true)))
                .andExpect(status().isUnprocessableEntity());
        List<String> tooMany = new ArrayList<>();
        for (int i = 0; i < 101; i++) {
            tooMany.add(UUID.randomUUID().toString());
        }
        read(bob, objectMapper.writeValueAsString(Map.of("ids", tooMany)))
                .andExpect(status().isUnprocessableEntity());

        assertThat(patchPreferenceStatus(bob, Map.of("type", "MESSAGE", "channel", "IN_APP",
                "mode", "BOGUS"))).isEqualTo(422);
        assertThat(patchPreferenceStatus(bob, Map.of("type", "MESSAGE", "channel", "IN_APP")))
                .isEqualTo(422);
        assertThat(patchPreferenceStatus(bob, Map.of("chat_id", UUID.randomUUID().toString(),
                "type", "MESSAGE", "channel", "IN_APP", "mode", "ALL"))).isEqualTo(403);

        // Global preference is an upsert, not a duplicate row.
        JsonNode created = patchPreference(bob, Map.of(
                "type", "MESSAGE", "channel", "IN_APP", "mode", "MUTE"));
        assertThat(created.get("chat_id").isNull()).isTrue();
        JsonNode updated = patchPreference(bob, Map.of(
                "type", "MESSAGE", "channel", "IN_APP", "mode", "ALL"));
        assertThat(updated.get("mode").asText()).isEqualTo("ALL");
        assertThat(getPreferences(bob).get("items").size()).isEqualTo(1);
    }

    @Test
    void retentionDeletesOnlyRowsOlderThanNinetyDays() throws Exception {
        SessionResponse bob = devSession();
        UUID old = UUID.randomUUID();
        UUID older = UUID.randomUUID();
        UUID recent = UUID.randomUUID();
        Instant now = Instant.now();
        insertNotification(bob, old, now.minus(100, ChronoUnit.DAYS), "old");
        insertNotification(bob, older, now.minus(91, ChronoUnit.DAYS), "older");
        insertNotification(bob, recent, now.minus(10, ChronoUnit.DAYS), "recent");

        int deleted = notificationRetentionService.run();

        assertThat(deleted).isGreaterThanOrEqualTo(2);
        assertThat(notificationExists(old)).isFalse();
        assertThat(notificationExists(older)).isFalse();
        assertThat(notificationExists(recent)).isTrue();
    }

    private void joinChat(SessionResponse owner, SessionResponse member) {
        migrator().update("""
                INSERT INTO chat.chat_members (chat_id, workspace_id, user_id, role, status)
                VALUES (?, ?, ?, 'MEMBER', 'ACTIVE')
                ON CONFLICT (chat_id, user_id) DO UPDATE SET status = 'ACTIVE'
                """, owner.chat().id(), owner.workspace().id(), member.user().id());
    }

    private UUID createChat(UUID workspaceId, UUID ownerId, String name, String mode,
                            List<UUID> memberIds) {
        UUID chatId = UUID.randomUUID();
        migrator().update("""
                INSERT INTO chat.chats (id, workspace_id, type, security_mode, name, created_by)
                VALUES (?, ?, 'GROUP', ?, ?, ?)
                """, chatId, workspaceId, mode, name, ownerId);
        for (UUID memberId : memberIds) {
            migrator().update("""
                    INSERT INTO chat.chat_members (chat_id, workspace_id, user_id, role, status)
                    VALUES (?, ?, ?, ?, 'ACTIVE')
                    ON CONFLICT (chat_id, user_id) DO UPDATE SET status = 'ACTIVE'
                    """, chatId, workspaceId, memberId,
                    memberId.equals(ownerId) ? "OWNER" : "MEMBER");
        }
        migrator().update("""
                INSERT INTO chat.chat_counters (chat_id, workspace_id) VALUES (?, ?)
                """, chatId, workspaceId);
        return chatId;
    }

    private JsonNode list(SessionResponse session, String cursor, Integer limit)
            throws Exception {
        MockHttpServletRequestBuilder request = authed(get("/api/v1/notifications"), session);
        if (cursor != null) {
            request.param("cursor", cursor);
        }
        if (limit != null) {
            request.param("limit", limit.toString());
        }
        MvcResult result = mockMvc.perform(request).andExpect(status().isOk()).andReturn();
        return json(result);
    }

    private org.springframework.test.web.servlet.ResultActions markRead(SessionResponse session,
                                                                       Map<String, Object> body)
            throws Exception {
        return read(session, objectMapper.writeValueAsString(body));
    }

    private org.springframework.test.web.servlet.ResultActions read(SessionResponse session,
                                                                   String body) throws Exception {
        return mockMvc.perform(authed(post("/api/v1/notifications/read"), session)
                .header("Idempotency-Key", randomKey())
                .contentType(MediaType.APPLICATION_JSON)
                .content(body));
    }

    private JsonNode getPreferences(SessionResponse session) throws Exception {
        MvcResult result = mockMvc.perform(authed(
                        get("/api/v1/notification-preferences"), session))
                .andExpect(status().isOk()).andReturn();
        return json(result);
    }

    private JsonNode patchPreference(SessionResponse session, Map<String, Object> body)
            throws Exception {
        MvcResult result = mockMvc.perform(authed(
                        patch("/api/v1/notification-preferences"), session)
                        .header("Idempotency-Key", randomKey())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(body)))
                .andReturn();
        if (result.getResponse().getStatus() != 200) {
            throw new IllegalStateException("preference patch failed: "
                    + result.getResponse().getStatus() + " "
                    + result.getResponse().getContentAsString());
        }
        return json(result);
    }

    private int patchPreferenceStatus(SessionResponse session, Map<String, Object> body)
            throws Exception {
        return mockMvc.perform(authed(patch("/api/v1/notification-preferences"), session)
                        .header("Idempotency-Key", randomKey())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(body)))
                .andReturn().getResponse().getStatus();
    }

    private int notificationCount(UUID userId, UUID chatId) {
        return migrator().queryForObject("""
                SELECT count(*) FROM notification.notifications
                 WHERE user_id = ? AND chat_id = ?
                """, Integer.class, userId, chatId);
    }

    private void insertNotification(SessionResponse session, UUID id, Instant createdAt,
                                    String marker) {
        migrator().update("""
                INSERT INTO notification.notifications
                       (id, user_id, workspace_id, chat_id, type, title, body, dedupe_key,
                        created_at)
                VALUES (?, ?, ?, NULL, 'MESSAGE', 'Новое сообщение', NULL, ?, ?)
                """, id, session.user().id(), session.workspace().id(),
                "retention-" + marker + "-" + UUID.randomUUID(), java.sql.Timestamp.from(createdAt));
    }

    private boolean notificationExists(UUID id) {
        return migrator().queryForObject(
                "SELECT count(*) FROM notification.notifications WHERE id = ?",
                Integer.class, id) == 1;
    }

    private static JsonNode findItem(JsonNode page, String id) {
        for (JsonNode item : page.get("items")) {
            if (item.get("id").asText().equals(id)) {
                return item;
            }
        }
        throw new AssertionError("notification not found: " + id);
    }

    private static String randomKey() {
        return UUID.randomUUID().toString();
    }

}
