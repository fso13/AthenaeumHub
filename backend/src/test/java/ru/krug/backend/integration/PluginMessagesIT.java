package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

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
import org.springframework.test.web.servlet.ResultActions;

import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.shared.application.model.IssuedToken;
import ru.krug.backend.shared.application.port.TokenIssuer;
import ru.krug.backend.support.IntegrationTestBase;
import ru.krug.backend.support.OpenApiContract;

/**
 * #95: a poll/task is also a timeline message. Covers entity+message atomicity, the
 * idempotent create replay (no duplicate message), embedded viewer-relative projections,
 * task completion reflected without a new message, seq accounting, permissions and the
 * DB/RLS backstops for direct SQL.
 */
@ActiveProfiles("test")
class PluginMessagesIT extends IntegrationTestBase {

    private static final OpenApiContract CONTRACT = OpenApiContract.load();

    @Autowired
    private TokenIssuer tokenIssuer;

    @Test
    void pollCreateCreatesMessageAndIdempotentReplayDoesNotDuplicate() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("pollmsg-owner"));
        SessionResponse member = devSession(uniqueDisplayName("pollmsg-member"));
        UUID workspaceId = owner.workspace().id();
        UUID chatId = createGroup(owner);
        joinWorkspace(workspaceId, member.user().id());
        joinChat(chatId, workspaceId, member.user().id(), "MEMBER");
        SessionResponse memberInChat = scoped(member, workspaceId);
        assertOk(patchPlugin(owner, chatId, "polls", true));

        String key = UUID.randomUUID().toString();
        String body = pollBody("Lunch?", "Pizza", "Sushi");
        MvcResult createdResult = postPoll(owner, chatId, body, key)
                .andExpect(status().isCreated()).andReturn();
        JsonNode created = json(createdResult);
        CONTRACT.assertValid("Poll", created);
        assertThat(created.get("message_id").isNull()).isFalse();
        UUID pollId = UUID.fromString(created.get("id").asText());
        UUID messageId = UUID.fromString(created.get("message_id").asText());
        String pizza = created.get("options").get(0).get("id").asText();

        Map<String, Object> row = migrator().queryForMap("""
                SELECT type, poll_id, task_id, body_ciphertext, seq, sender_id,
                       client_message_id
                  FROM message.messages WHERE id = ?
                """, messageId);
        assertThat(row.get("type")).isEqualTo("POLL");
        assertThat(row.get("poll_id")).isEqualTo(pollId);
        assertThat(row.get("task_id")).isNull();
        assertThat(row.get("body_ciphertext")).isNull();
        assertThat(((Number) row.get("seq")).longValue()).isEqualTo(1L);
        assertThat(row.get("sender_id")).isEqualTo(owner.user().id());
        assertThat(row.get("client_message_id")).isNull();
        assertThat(messageCount(chatId)).isEqualTo(1);
        assertThat(counterNextSeq(chatId)).isEqualTo(2);

        JsonNode message = onlyMessage(owner, chatId, 1, "MessagePage");
        CONTRACT.assertValid("Message", message);
        assertThat(message.get("id").asText()).isEqualTo(messageId.toString());
        assertThat(message.get("type").asText()).isEqualTo("POLL");
        assertThat(message.get("text").isNull()).isTrue();
        assertThat(message.get("poll_id").asText()).isEqualTo(pollId.toString());
        assertThat(message.get("poll").get("question").asText()).isEqualTo("Lunch?");
        assertThat(message.get("poll").get("options")).hasSize(2);
        assertThat(message.get("poll").has("my_option_id")).isFalse();
        assertThat(message.has("task")).isFalse();

        // Same key + same body: replay the original poll and message, no second row.
        MvcResult replayResult = postPoll(owner, chatId, body, key)
                .andExpect(status().isCreated()).andReturn();
        JsonNode replay = json(replayResult);
        assertThat(replayResult.getResponse().getHeader("Idempotent-Replay")).isEqualTo("true");
        assertThat(replay.get("id").asText()).isEqualTo(pollId.toString());
        assertThat(replay.get("message_id").asText()).isEqualTo(messageId.toString());
        assertThat(pollCount(chatId)).isEqualTo(1);
        assertThat(messageCount(chatId)).isEqualTo(1);
        assertThat(counterNextSeq(chatId)).isEqualTo(2);
        assertThat(auditCount("chat.poll.created", pollId)).isEqualTo(1);

        // Same key + different body is a conflict and still does not create anything.
        assertError(postPoll(owner, chatId, pollBody("Other?", "A", "B"), key), 409,
                "IDEMPOTENCY_KEY_REUSED");
        assertThat(pollCount(chatId)).isEqualTo(1);
        assertThat(messageCount(chatId)).isEqualTo(1);

        // Vote: no new message/seq, and the embedded projection is viewer-relative.
        JsonNode voted = json(postVote(memberInChat, chatId, pollId.toString(), pizza)
                .andExpect(status().isOk()).andReturn());
        assertThat(voted.get("total_votes").asInt()).isEqualTo(1);
        JsonNode memberMessage = onlyMessage(memberInChat, chatId, 1, "MessagePage");
        assertThat(memberMessage.get("poll").get("my_option_id").asText()).isEqualTo(pizza);
        JsonNode ownerMessage = onlyMessage(owner, chatId, 1, "MessagePage");
        assertThat(ownerMessage.get("poll").has("my_option_id")).isFalse();
        assertThat(messageCount(chatId)).isEqualTo(1);
        assertThat(counterNextSeq(chatId)).isEqualTo(2);

        // Closing is reflected in the embedded poll without rewriting the message.
        assertOk(closePoll(owner, chatId, pollId.toString(), true));
        JsonNode closedMessage = onlyMessage(memberInChat, chatId, 1, "MessagePage");
        assertThat(closedMessage.get("poll").get("closed").asBoolean()).isTrue();
        assertThat(closedMessage.get("poll").get("closed_at").isNull()).isFalse();
        assertThat(messageCount(chatId)).isEqualTo(1);
    }

    @Test
    void taskCompletionIsReflectedAndDeleteLeavesATombstone() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("taskmsg-owner"));
        SessionResponse assignee = devSession(uniqueDisplayName("taskmsg-assignee"));
        UUID workspaceId = owner.workspace().id();
        UUID chatId = createGroup(owner);
        joinWorkspace(workspaceId, assignee.user().id());
        joinChat(chatId, workspaceId, assignee.user().id(), "MEMBER");
        SessionResponse assigneeInChat = scoped(assignee, workspaceId);
        assertOk(patchPlugin(owner, chatId, "tasks", true));

        Map<String, Object> create = new LinkedHashMap<>();
        create.put("title", "  Prepare report  ");
        create.put("assignee_id", assignee.user().id().toString());
        create.put("due_at", "2030-01-01T10:00:00Z");
        String key = UUID.randomUUID().toString();
        JsonNode task = json(postTask(owner, chatId, create, key)
                .andExpect(status().isCreated()).andReturn());
        CONTRACT.assertValid("Task", task);
        UUID taskId = UUID.fromString(task.get("id").asText());
        UUID messageId = UUID.fromString(task.get("message_id").asText());

        assertThat(taskCount(chatId)).isEqualTo(1);
        assertThat(messageCount(chatId)).isEqualTo(1);
        assertThat(counterNextSeq(chatId)).isEqualTo(2);
        JsonNode before = onlyMessage(assigneeInChat, chatId, 1, "MessagePage");
        CONTRACT.assertValid("Message", before);
        assertThat(before.get("type").asText()).isEqualTo("TASK");
        assertThat(before.get("text").isNull()).isTrue();
        assertThat(before.get("task_id").asText()).isEqualTo(taskId.toString());
        assertThat(before.get("task").get("title").asText()).isEqualTo("Prepare report");
        assertThat(before.get("task").get("assignee_id").asText())
                .isEqualTo(assignee.user().id().toString());
        assertThat(before.get("task").get("done").asBoolean()).isFalse();

        // The assignee may complete it; the message is not rewritten and no seq is consumed.
        JsonNode done = json(patchTask(assigneeInChat, chatId, taskId.toString(), true)
                .andExpect(status().isOk()).andReturn());
        assertThat(done.get("done").asBoolean()).isTrue();
        JsonNode after = onlyMessage(assigneeInChat, chatId, 1, "MessagePage");
        assertThat(after.get("task").get("done").asBoolean()).isTrue();
        assertThat(after.get("task").get("completed_by").asText())
                .isEqualTo(assignee.user().id().toString());
        assertThat(after.get("task").get("completed_at").isNull()).isFalse();
        assertThat(messageCount(chatId)).isEqualTo(1);
        assertThat(counterNextSeq(chatId)).isEqualTo(2);

        // Reopen is reflected too.
        assertOk(patchTask(owner, chatId, taskId.toString(), false));
        JsonNode reopened = onlyMessage(owner, chatId, 1, "MessagePage");
        assertThat(reopened.get("task").get("done").asBoolean()).isFalse();
        assertThat(reopened.get("task").has("completed_by")).isFalse();

        // Delete-for-all uses the normal message tombstone: the row/seq stay, content goes.
        mockMvc.perform(authed(delete("/api/v1/chats/{chatId}/messages/{messageId}", chatId,
                        messageId), owner).param("scope", "all"))
                .andExpect(status().isNoContent());
        JsonNode tombstone = onlyMessage(owner, chatId, 1, "MessagePage");
        CONTRACT.assertValid("Message", tombstone);
        assertThat(tombstone.get("type").asText()).isEqualTo("TASK");
        assertThat(tombstone.get("text").isNull()).isTrue();
        assertThat(tombstone.get("deleted_at").isNull()).isFalse();
        assertThat(tombstone.has("task_id")).isFalse();
        assertThat(tombstone.has("task")).isFalse();
        assertThat(messageCount(chatId)).isEqualTo(1);
        // The task entity itself is untouched by the message tombstone.
        assertThat(taskCount(chatId)).isEqualTo(1);
    }

    @Test
    void permissionGateRejectsWithoutCreatingAMessage() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("pollmsg-perm-owner"));
        SessionResponse guest = devSession(uniqueDisplayName("pollmsg-guest"));
        UUID workspaceId = owner.workspace().id();
        UUID chatId = createGroup(owner);
        joinWorkspace(workspaceId, guest.user().id());
        joinChat(chatId, workspaceId, guest.user().id(), "GUEST");
        SessionResponse guestInChat = scoped(guest, workspaceId);

        assertError(postPoll(owner, chatId, pollBody("Disabled?", "A", "B"),
                UUID.randomUUID().toString()), 422, "PLUGIN_NOT_ENABLED");
        assertThat(pollCount(chatId)).isZero();
        assertThat(messageCount(chatId)).isZero();

        assertOk(patchPlugin(owner, chatId, "polls", true));
        assertError(postPoll(guestInChat, chatId, pollBody("Guest?", "A", "B"),
                UUID.randomUUID().toString()), 403, "CHAT_PERMISSION_DENIED");
        assertThat(pollCount(chatId)).isZero();
        assertThat(messageCount(chatId)).isZero();
    }

    @Test
    void clientCannotCreatePollOrTaskMessages() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("pollmsg-client"));
        UUID chatId = createGroup(owner);
        for (String type : List.of("POLL", "TASK")) {
            assertError(mockMvc.perform(authed(
                            post("/api/v1/chats/{chatId}/messages", chatId), owner)
                    .header("Idempotency-Key", UUID.randomUUID().toString())
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(objectMapper.writeValueAsString(Map.of(
                            "client_message_id", UUID.randomUUID().toString(),
                            "type", type)))), 400, "VALIDATION_FAILED");
        }
        assertThat(messageCount(chatId)).isZero();
    }

    @Test
    void databaseRejectsWrongReferencesAndDoesNotLeakPluginMessagesAcrossTenants()
            throws Exception {
        SessionResponse first = devSession(uniqueDisplayName("pollmsg-db-a"));
        SessionResponse second = devSession(uniqueDisplayName("pollmsg-db-b"));
        UUID chatA = createGroup(first);
        assertOk(patchPlugin(first, chatA, "polls", true));
        JsonNode poll = json(postPoll(first, chatA, pollBody("DB?", "A", "B"),
                UUID.randomUUID().toString()).andExpect(status().isCreated()).andReturn());
        UUID pollId = UUID.fromString(poll.get("id").asText());
        UUID messageId = UUID.fromString(poll.get("message_id").asText());

        // Cross-workspace/chat reference: FK alone would allow it, the trigger must not.
        assertThatThrownBy(() -> migrator().update("""
                INSERT INTO message.messages
                       (id, workspace_id, chat_id, seq, sender_id, type, crypto_scheme, poll_id)
                VALUES (?, ?, ?, 9001, ?, 'POLL', 'MANAGED', ?)
                """, UUID.randomUUID(), second.workspace().id(), second.chat().id(),
                second.user().id(), pollId))
                .isInstanceOf(DataAccessException.class);

        // Exactly-one reference per type and no body for POLL/TASK.
        assertThatThrownBy(() -> migrator().update("""
                INSERT INTO message.messages
                       (id, workspace_id, chat_id, seq, sender_id, type, crypto_scheme, poll_id)
                VALUES (?, ?, ?, 9002, ?, 'TASK', 'MANAGED', ?)
                """, UUID.randomUUID(), first.workspace().id(), chatA, first.user().id(),
                pollId))
                .isInstanceOf(DataAccessException.class);
        assertThatThrownBy(() -> migrator().update("""
                INSERT INTO message.messages
                       (id, workspace_id, chat_id, seq, sender_id, type, crypto_scheme,
                        poll_id, body_ciphertext)
                VALUES (?, ?, ?, 9003, ?, 'POLL', 'MANAGED', ?, 'x'::bytea)
                """, UUID.randomUUID(), first.workspace().id(), chatA, first.user().id(),
                pollId))
                .isInstanceOf(DataAccessException.class);

        // RLS: the runtime role in another tenant cannot see the POLL message.
        List<UUID> otherTenantRows = inTenant(second.user().id(), second.workspace().id(),
                () -> jdbc.queryForList("SELECT id FROM message.messages WHERE id = ?",
                        UUID.class, messageId));
        assertThat(otherTenantRows).isEmpty();
        List<UUID> ownTenantRows = inTenant(first.user().id(), first.workspace().id(),
                () -> jdbc.queryForList("SELECT id FROM message.messages WHERE id = ?",
                        UUID.class, messageId));
        assertThat(ownTenantRows).containsExactly(messageId);
    }

    // ------------------------------------------------------------------

    private JsonNode onlyMessage(SessionResponse actor, UUID chatId, long seq,
                                 String schema) throws Exception {
        MvcResult result = mockMvc.perform(authed(
                        get("/api/v1/chats/{chatId}/messages", chatId), actor))
                .andExpect(status().isOk()).andReturn();
        JsonNode page = json(result);
        CONTRACT.assertValid(schema, page);
        assertThat(page.get("items")).hasSize(1);
        JsonNode message = page.get("items").get(0);
        if (seq > 0) {
            assertThat(message.get("seq").asLong()).isEqualTo(seq);
        }
        return message;
    }

    private ResultActions patchPlugin(SessionResponse actor, UUID chatId, String pluginId,
                                      boolean enabled) throws Exception {
        return mockMvc.perform(authed(
                        patch("/api/v1/chats/{chatId}/plugins/{pluginId}", chatId, pluginId),
                        actor)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(Map.of("enabled", enabled))));
    }

    private ResultActions postPoll(SessionResponse actor, UUID chatId, String body, String key)
            throws Exception {
        return mockMvc.perform(authed(post("/api/v1/chats/{chatId}/polls", chatId), actor)
                .header("Idempotency-Key", key)
                .contentType(MediaType.APPLICATION_JSON)
                .content(body));
    }

    private ResultActions postVote(SessionResponse actor, UUID chatId, String pollId,
                                   String optionId) throws Exception {
        return mockMvc.perform(authed(post(
                        "/api/v1/chats/{chatId}/polls/{pollId}/votes", chatId, pollId), actor)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(Map.of("option_id", optionId))));
    }

    private ResultActions closePoll(SessionResponse actor, UUID chatId, String pollId,
                                    boolean closed) throws Exception {
        return mockMvc.perform(authed(patch(
                        "/api/v1/chats/{chatId}/polls/{pollId}", chatId, pollId), actor)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(Map.of("closed", closed))));
    }

    private ResultActions postTask(SessionResponse actor, UUID chatId,
                                   Map<String, Object> body, String key) throws Exception {
        return mockMvc.perform(authed(post("/api/v1/chats/{chatId}/tasks", chatId), actor)
                .header("Idempotency-Key", key)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(body)));
    }

    private ResultActions patchTask(SessionResponse actor, UUID chatId, String taskId,
                                    boolean done) throws Exception {
        return mockMvc.perform(authed(patch(
                        "/api/v1/chats/{chatId}/tasks/{taskId}", chatId, taskId), actor)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(Map.of("done", done))));
    }

    private String pollBody(String question, String... options) throws Exception {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("question", question);
        body.put("options", List.of(options));
        return objectMapper.writeValueAsString(body);
    }

    private UUID createGroup(SessionResponse owner) throws Exception {
        MvcResult result = mockMvc.perform(authed(
                        post("/api/v1/workspaces/{workspaceId}/chats", owner.workspace().id()),
                        owner)
                        .header("Idempotency-Key", UUID.randomUUID().toString())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "type", "GROUP",
                                "name", "plugin-messages-" + UUID.randomUUID()))))
                .andExpect(status().isCreated())
                .andReturn();
        return UUID.fromString(json(result).get("id").asText());
    }

    private void joinWorkspace(UUID workspaceId, UUID userId) {
        migrator().update("""
                INSERT INTO workspace.memberships (workspace_id, user_id, role, status)
                VALUES (?, ?, 'MEMBER', 'ACTIVE')
                ON CONFLICT (workspace_id, user_id) DO UPDATE SET status = 'ACTIVE'
                """, workspaceId, userId);
    }

    private void joinChat(UUID chatId, UUID workspaceId, UUID userId, String role) {
        migrator().update("""
                INSERT INTO chat.chat_members (chat_id, workspace_id, user_id, role, status)
                VALUES (?, ?, ?, ?, 'ACTIVE')
                ON CONFLICT (chat_id, user_id) DO UPDATE
                   SET role = EXCLUDED.role, status = 'ACTIVE', updated_at = now()
                """, chatId, workspaceId, userId, role);
    }

    private SessionResponse scoped(SessionResponse user, UUID workspaceId) {
        IssuedToken token = tokenIssuer.issue(user.user().id(), user.device().id(), workspaceId);
        return new SessionResponse(token.accessToken(), token.expiresAt(), user.user(),
                user.device(), user.workspace(), user.chat());
    }

    private void assertOk(ResultActions actions) throws Exception {
        actions.andExpect(status().isOk());
    }

    private void assertError(ResultActions actions, int status, String code) throws Exception {
        MvcResult result = actions.andExpect(status().is(status)).andReturn();
        JsonNode body = json(result);
        CONTRACT.assertValid("Error", body);
        assertThat(body.get("code").asText()).as(body.toString()).isEqualTo(code);
    }

    private long counterNextSeq(UUID chatId) {
        Long value = migrator().queryForObject(
                "SELECT next_seq FROM chat.chat_counters WHERE chat_id = ?", Long.class, chatId);
        return value == null ? -1 : value;
    }

    private long pollCount(UUID chatId) {
        Long count = migrator().queryForObject(
                "SELECT count(*) FROM plugin.polls WHERE chat_id = ?", Long.class, chatId);
        return count == null ? 0 : count;
    }

    private long taskCount(UUID chatId) {
        Long count = migrator().queryForObject(
                "SELECT count(*) FROM plugin.tasks WHERE chat_id = ?", Long.class, chatId);
        return count == null ? 0 : count;
    }

    private long auditCount(String action, UUID targetId) {
        Long count = migrator().queryForObject("""
                SELECT count(*) FROM audit.audit_events
                 WHERE action = ? AND target_id = ?
                """, Long.class, action, targetId);
        return count == null ? 0 : count;
    }
}
