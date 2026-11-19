package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
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
import ru.krug.backend.support.StickerTestSupport;

/**
 * D1.1 (#76) plugin actions: polls, tasks and the unconfigured translation provider.
 * Covers membership, per-chat plugin toggles, vote idempotency, task permissions,
 * managed-only translation, audit ids-only and RLS/DB backstops.
 */
@ActiveProfiles("test")
class PluginActionsIT extends IntegrationTestBase {

    private static final OpenApiContract CONTRACT = OpenApiContract.load();

    @Autowired
    private TokenIssuer tokenIssuer;

    @Test
    void pollsRequireEnabledPluginAndActiveChatMembership() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("actions-polls-owner"));
        SessionResponse member = devSession(uniqueDisplayName("actions-polls-member"));
        SessionResponse workspaceOnly = devSession(uniqueDisplayName("actions-polls-ws"));
        SessionResponse outsider = devSession(uniqueDisplayName("actions-polls-out"));
        UUID workspaceId = owner.workspace().id();
        UUID chatId = createGroup(owner);
        joinWorkspace(workspaceId, member.user().id());
        joinWorkspace(workspaceId, workspaceOnly.user().id());
        joinChat(chatId, workspaceId, member.user().id(), "MEMBER");
        SessionResponse memberInChat = scoped(member, workspaceId);
        SessionResponse workspaceOnlyInChat = scoped(workspaceOnly, workspaceId);

        // Disabled plugin: every action is 422 and nothing is persisted.
        assertError(getPolls(owner, chatId), 422, "PLUGIN_NOT_ENABLED");
        assertError(postPoll(owner, chatId, pollBody("Disabled?", "a", "b")), 422,
                "PLUGIN_NOT_ENABLED");
        assertThat(pollCount(chatId)).isZero();
        assertThat(auditCount("chat.poll.created", chatId)).isZero();

        assertOk(patchPlugin(owner, chatId, "polls", true));
        JsonNode empty = listPolls(owner, chatId);
        CONTRACT.assertValid("PollList", empty);
        assertThat(empty.get("items")).isEmpty();

        JsonNode created = json(postPoll(owner, chatId,
                pollBody("  Lunch?  ", "  Pizza ", "Sushi")).andExpect(status().isCreated())
                .andReturn());
        CONTRACT.assertValid("Poll", created);
        assertThat(created.get("question").asText()).isEqualTo("Lunch?");
        assertThat(created.get("options")).hasSize(2);
        assertThat(created.get("options").get(0).get("text").asText()).isEqualTo("Pizza");
        assertThat(created.get("total_votes").asInt()).isZero();
        assertThat(created.get("my_option_id").isNull()).isTrue();
        String pollId = created.get("id").asText();
        String firstOption = created.get("options").get(0).get("id").asText();

        // An ACTIVE chat MEMBER sees the poll and can vote.
        JsonNode memberView = listPolls(memberInChat, chatId);
        CONTRACT.assertValid("PollList", memberView);
        assertThat(memberView.get("items")).hasSize(1);
        assertThat(memberView.get("items").get(0).get("my_option_id").isNull()).isTrue();
        JsonNode voted = vote(memberInChat, chatId, pollId, firstOption);
        CONTRACT.assertValid("Poll", voted);
        assertThat(voted.get("my_option_id").asText()).isEqualTo(firstOption);
        assertThat(voted.get("total_votes").asInt()).isEqualTo(1);

        // Workspace members without chat membership and outsiders learn nothing.
        assertError(getPolls(workspaceOnlyInChat, chatId), 404, "NOT_FOUND");
        assertError(postPoll(workspaceOnlyInChat, chatId, pollBody("Nope?", "a", "b")), 404,
                "NOT_FOUND");
        assertError(voteAction(workspaceOnlyInChat, chatId, pollId, firstOption), 404,
                "NOT_FOUND");
        assertError(getPolls(outsider, chatId), 404, "NOT_FOUND");

        // A removed chat membership is treated as an unknown chat.
        migrator().update("""
                UPDATE chat.chat_members SET status = 'REMOVED'
                 WHERE chat_id = ? AND user_id = ?
                """, chatId, member.user().id());
        assertError(getPolls(memberInChat, chatId), 404, "NOT_FOUND");
        assertError(voteAction(memberInChat, chatId, pollId, firstOption), 404, "NOT_FOUND");
    }

    @Test
    void pollVotesAreSingleAndChangeableAndOnlyCreatorCloses() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("actions-vote-owner"));
        SessionResponse member = devSession(uniqueDisplayName("actions-vote-member"));
        UUID workspaceId = owner.workspace().id();
        UUID chatId = createGroup(owner);
        joinWorkspace(workspaceId, member.user().id());
        joinChat(chatId, workspaceId, member.user().id(), "MEMBER");
        SessionResponse memberInChat = scoped(member, workspaceId);
        assertOk(patchPlugin(owner, chatId, "polls", true));

        JsonNode poll = json(postPoll(owner, chatId,
                pollBody("Where?", "Office", "Remote", "Hybrid"))
                .andExpect(status().isCreated()).andReturn());
        String pollId = poll.get("id").asText();
        String office = poll.get("options").get(0).get("id").asText();
        String remote = poll.get("options").get(1).get("id").asText();

        JsonNode firstVote = vote(memberInChat, chatId, pollId, office);
        assertThat(firstVote.get("total_votes").asInt()).isEqualTo(1);
        assertThat(optionVotes(firstVote, office)).isEqualTo(1);
        assertThat(optionVotes(firstVote, remote)).isZero();
        assertThat(auditCount("chat.poll.voted", UUID.fromString(pollId))).isEqualTo(1);
        String firstUpdatedAt = String.valueOf(pollVoteRow(pollId, member.user().id())
                .get("updated_at"));

        // Repeating the same choice is a 200 no-op: no extra audit and no updated_at change.
        JsonNode repeat = vote(memberInChat, chatId, pollId, office);
        assertThat(repeat.get("total_votes").asInt()).isEqualTo(1);
        assertThat(auditCount("chat.poll.voted", UUID.fromString(pollId))).isEqualTo(1);
        assertThat(String.valueOf(pollVoteRow(pollId, member.user().id()).get("updated_at")))
                .isEqualTo(firstUpdatedAt);

        // Changing the choice moves the one vote, never adds a second one.
        JsonNode changed = vote(memberInChat, chatId, pollId, remote);
        assertThat(changed.get("total_votes").asInt()).isEqualTo(1);
        assertThat(optionVotes(changed, office)).isZero();
        assertThat(optionVotes(changed, remote)).isEqualTo(1);
        assertThat(changed.get("my_option_id").asText()).isEqualTo(remote);
        assertThat(auditCount("chat.poll.voted", UUID.fromString(pollId))).isEqualTo(2);

        // An option of a different poll is rejected before any write.
        JsonNode otherPoll = json(postPoll(owner, chatId,
                pollBody("Other?", "One", "Two")).andExpect(status().isCreated()).andReturn());
        String foreignOption = otherPoll.get("options").get(0).get("id").asText();
        assertError(voteAction(memberInChat, chatId, pollId, foreignOption), 422,
                "POLL_OPTION_INVALID");
        assertThat(voteCount(pollId)).isEqualTo(1);
        assertThat(auditCount("chat.poll.voted", UUID.fromString(pollId))).isEqualTo(2);

        // Unknown poll and non-creator close.
        assertError(voteAction(memberInChat, chatId, UUID.randomUUID().toString(), remote),
                404, "NOT_FOUND");
        assertError(closePoll(memberInChat, chatId, pollId, true), 403, "FORBIDDEN");
        assertError(closePoll(owner, chatId, pollId, false), 422, "POLL_STATE_INVALID");

        JsonNode closed = json(closePoll(owner, chatId, pollId, true)
                .andExpect(status().isOk()).andReturn());
        CONTRACT.assertValid("Poll", closed);
        assertThat(closed.get("closed").asBoolean()).isTrue();
        assertThat(closed.get("closed_at").isNull()).isFalse();
        assertThat(auditCount("chat.poll.closed", UUID.fromString(pollId))).isEqualTo(1);

        // Repeat close is idempotent; voting in a closed poll is rejected.
        assertOk(closePoll(owner, chatId, pollId, true));
        assertThat(auditCount("chat.poll.closed", UUID.fromString(pollId))).isEqualTo(1);
        assertError(voteAction(memberInChat, chatId, pollId, office), 422, "POLL_CLOSED");
        assertThat(voteCount(pollId)).isEqualTo(1);

        // Audit never carries the question/option text.
        String question = "Where?";
        for (Map<String, Object> event : migrator().queryForList("""
                SELECT action, metadata::text AS metadata
                  FROM audit.audit_events
                 WHERE target_id IN (?, ?) AND target_type = 'poll'
                """, UUID.fromString(pollId), UUID.fromString(otherPoll.get("id").asText()))) {
            String raw = String.valueOf(event.get("metadata"));
            assertThat(raw).doesNotContain(question).doesNotContain("Office")
                    .doesNotContain("Remote").doesNotContain("Hybrid");
        }
    }

    @Test
    void pollCreationValidationRejectsMalformedInput() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("actions-poll-validation"));
        UUID chatId = createGroup(owner);
        assertOk(patchPlugin(owner, chatId, "polls", true));

        assertError(postPoll(owner, chatId, pollBody("   ", "a", "b")), 422,
                "VALIDATION_FAILED");
        assertError(postPoll(owner, chatId, pollBody("One option?", "only")), 400,
                "VALIDATION_FAILED");
        assertError(postPoll(owner, chatId,
                pollBody("Too many?", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10",
                        "11")), 400, "VALIDATION_FAILED");
        assertError(postPoll(owner, chatId, pollBody("Duplicate?", "same", "same")), 422,
                "VALIDATION_FAILED");
        assertError(postPoll(owner, chatId, pollBody("<b>HTML</b>?", "a", "b")), 422,
                "VALIDATION_FAILED");
        assertError(postPoll(owner, chatId, pollBody("Big option?", "x".repeat(201), "b")),
                400, "VALIDATION_FAILED");

        assertThat(pollCount(chatId)).isZero();
        assertThat(auditCount("chat.poll.created", chatId)).isZero();
    }

    @Test
    void tasksRequireEnabledPluginAndRespectCompletionPermissions() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("actions-task-owner"));
        SessionResponse admin = devSession(uniqueDisplayName("actions-task-admin"));
        SessionResponse member = devSession(uniqueDisplayName("actions-task-member"));
        SessionResponse otherMember = devSession(uniqueDisplayName("actions-task-other"));
        SessionResponse workspaceOnly = devSession(uniqueDisplayName("actions-task-ws"));
        SessionResponse outsider = devSession(uniqueDisplayName("actions-task-out"));
        UUID workspaceId = owner.workspace().id();
        UUID chatId = createGroup(owner);
        for (SessionResponse user : new SessionResponse[]{admin, member, otherMember,
                workspaceOnly}) {
            joinWorkspace(workspaceId, user.user().id());
        }
        joinChat(chatId, workspaceId, admin.user().id(), "ADMIN");
        joinChat(chatId, workspaceId, member.user().id(), "MEMBER");
        joinChat(chatId, workspaceId, otherMember.user().id(), "MEMBER");
        SessionResponse adminInChat = scoped(admin, workspaceId);
        SessionResponse memberInChat = scoped(member, workspaceId);
        SessionResponse otherMemberInChat = scoped(otherMember, workspaceId);
        SessionResponse workspaceOnlyInChat = scoped(workspaceOnly, workspaceId);

        assertError(getTasks(owner, chatId), 422, "PLUGIN_NOT_ENABLED");
        assertError(postTask(owner, chatId, Map.of("title", "Disabled")), 422,
                "PLUGIN_NOT_ENABLED");
        assertThat(taskCount(chatId)).isZero();

        assertOk(patchPlugin(owner, chatId, "tasks", true));

        Map<String, Object> create = new LinkedHashMap<>();
        create.put("title", "  Prepare report  ");
        create.put("assignee_id", member.user().id().toString());
        create.put("due_at", "2030-01-01T10:00:00Z");
        JsonNode task = json(postTask(owner, chatId, create)
                .andExpect(status().isCreated()).andReturn());
        CONTRACT.assertValid("Task", task);
        assertThat(task.get("title").asText()).isEqualTo("Prepare report");
        assertThat(task.get("assignee_id").asText()).isEqualTo(member.user().id().toString());
        assertThat(task.get("done").asBoolean()).isFalse();
        String taskId = task.get("id").asText();

        JsonNode listed = json(getTasks(memberInChat, chatId).andExpect(status().isOk())
                .andReturn());
        CONTRACT.assertValid("TaskList", listed);
        assertThat(listed.get("items")).hasSize(1);

        // Arbitrary user ids are rejected: workspace-only and random ids are not chat members.
        assertError(postTask(owner, chatId, Map.of("title", "Foreign",
                "assignee_id", workspaceOnly.user().id().toString())), 422,
                "TASK_ASSIGNEE_INVALID");
        assertError(postTask(owner, chatId, Map.of("title", "Random",
                "assignee_id", UUID.randomUUID().toString())), 422,
                "TASK_ASSIGNEE_INVALID");
        assertThat(taskCount(chatId)).isEqualTo(1);

        // A plain member neither created nor assigned cannot complete.
        assertError(patchTask(otherMemberInChat, chatId, taskId, true), 403, "FORBIDDEN");
        assertThat(auditCount("chat.task.completed", UUID.fromString(taskId))).isZero();

        // The assignee can complete; repeating is idempotent.
        JsonNode completed = json(patchTask(memberInChat, chatId, taskId, true)
                .andExpect(status().isOk()).andReturn());
        assertThat(completed.get("done").asBoolean()).isTrue();
        assertThat(completed.get("completed_by").asText())
                .isEqualTo(member.user().id().toString());
        assertThat(completed.get("completed_at").isNull()).isFalse();
        assertThat(auditCount("chat.task.completed", UUID.fromString(taskId))).isEqualTo(1);

        assertOk(patchTask(memberInChat, chatId, taskId, true));
        assertThat(auditCount("chat.task.completed", UUID.fromString(taskId))).isEqualTo(1);

        // The creator can reopen; the manager can then complete someone else's task.
        JsonNode reopened = json(patchTask(owner, chatId, taskId, false)
                .andExpect(status().isOk()).andReturn());
        assertThat(reopened.get("done").asBoolean()).isFalse();
        assertThat(reopened.get("completed_by").isNull()).isTrue();
        assertThat(auditCount("chat.task.reopened", UUID.fromString(taskId))).isEqualTo(1);

        JsonNode managerCompleted = json(patchTask(adminInChat, chatId, taskId, true)
                .andExpect(status().isOk()).andReturn());
        assertThat(managerCompleted.get("completed_by").asText())
                .isEqualTo(admin.user().id().toString());
        assertThat(auditCount("chat.task.completed", UUID.fromString(taskId))).isEqualTo(2);

        // Non-members cannot read or write, even with the plugin enabled.
        assertError(getTasks(workspaceOnlyInChat, chatId), 404, "NOT_FOUND");
        assertError(patchTask(workspaceOnlyInChat, chatId, taskId, false), 404, "NOT_FOUND");
        assertError(getTasks(outsider, chatId), 404, "NOT_FOUND");

        assertError(postTask(owner, chatId, Map.of("title", "<b>HTML</b>")), 422,
                "VALIDATION_FAILED");

        // Audit contains ids only, never the title.
        for (Map<String, Object> event : migrator().queryForList("""
                SELECT metadata::text AS metadata FROM audit.audit_events
                 WHERE target_id = ? AND target_type = 'task'
                """, UUID.fromString(taskId))) {
            assertThat(String.valueOf(event.get("metadata")))
                    .doesNotContain("Prepare").doesNotContain("report");
        }
    }

    @Test
    void translationNeedsEnabledPluginManagedTextAndConfiguredProvider() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("actions-translate-owner"));
        SessionResponse member = devSession(uniqueDisplayName("actions-translate-member"));
        SessionResponse workspaceOnly = devSession(uniqueDisplayName("actions-translate-ws"));
        UUID workspaceId = owner.workspace().id();
        UUID chatId = createGroup(owner);
        joinWorkspace(workspaceId, member.user().id());
        joinWorkspace(workspaceId, workspaceOnly.user().id());
        joinChat(chatId, workspaceId, member.user().id(), "MEMBER");
        SessionResponse memberInChat = scoped(member, workspaceId);
        SessionResponse workspaceOnlyInChat = scoped(workspaceOnly, workspaceId);

        JsonNode message = sendMessage(owner, chatId, UUID.randomUUID().toString(),
                UUID.randomUUID().toString(), "Hello, world");
        String messageId = message.get("id").asText();

        // Plugin disabled: rejected before any message/provider work.
        assertError(translate(memberInChat, chatId, messageId, "ru"), 422,
                "PLUGIN_NOT_ENABLED");
        assertOk(patchPlugin(owner, chatId, "translate", true));

        // No provider configured by default: 503 + Retry-After, no fake success.
        MvcResult unavailable = translate(memberInChat, chatId, messageId, "ru")
                .andExpect(status().isServiceUnavailable()).andReturn();
        JsonNode unavailableBody = json(unavailable);
        CONTRACT.assertValid("Error", unavailableBody);
        assertThat(unavailableBody.get("code").asText()).isEqualTo("TRANSLATION_UNAVAILABLE");
        assertThat(unavailable.getResponse().getHeader("Retry-After")).isEqualTo("30");
        assertThat(auditCount("chat.message.translated", UUID.fromString(messageId)))
                .isZero();

        assertError(translate(memberInChat, chatId, messageId, "ru_RU"), 400,
                "VALIDATION_FAILED");
        assertError(translate(memberInChat, chatId, UUID.randomUUID().toString(), "ru"),
                404, "NOT_FOUND");
        assertError(translate(workspaceOnlyInChat, chatId, messageId, "ru"), 404,
                "NOT_FOUND");

        // A message of another chat is hidden.
        UUID otherChat = createGroup(owner);
        JsonNode otherMessage = sendMessage(owner, otherChat, UUID.randomUUID().toString(),
                UUID.randomUUID().toString(), "Other");
        assertError(translate(memberInChat, chatId, otherMessage.get("id").asText(), "ru"),
                404, "NOT_FOUND");

        // Non-TEXT messages are not translatable.
        MvcResult sticker = sendSticker(owner, chatId, StickerTestSupport.KRUG_01,
                UUID.randomUUID().toString(), UUID.randomUUID().toString());
        assertThat(sticker.getResponse().getStatus())
                .as(sticker.getResponse().getContentAsString()).isEqualTo(201);
        assertError(translate(memberInChat, chatId, json(sticker).get("id").asText(), "ru"),
                422, "MESSAGE_NOT_TRANSLATABLE");
    }

    @Test
    void schemaHasRlsGrantsAndTenantIsolationForPluginActions() throws Exception {
        String[][] tables = {
                {"plugin.polls", "SELECT", "INSERT", "UPDATE"},
                {"plugin.poll_options", "SELECT", "INSERT"},
                {"plugin.poll_votes", "SELECT", "INSERT", "UPDATE"},
                {"plugin.tasks", "SELECT", "INSERT", "UPDATE"},
        };
        for (String[] table : tables) {
            String name = table[0];
            Map<String, Object> flags = jdbc.queryForMap("""
                    SELECT relrowsecurity, relforcerowsecurity FROM pg_class
                     WHERE oid = ?::regclass
                    """, name);
            assertThat(flags.get("relrowsecurity")).as(name).isEqualTo(true);
            assertThat(flags.get("relforcerowsecurity")).as(name).isEqualTo(true);
            for (int i = 1; i < table.length; i++) {
                String privilege = table[i];
                assertThat(jdbc.queryForObject(
                        "SELECT has_table_privilege('krug_app', ?, ?)", Boolean.class,
                        name, privilege)).as(name + " " + privilege).isTrue();
            }
            assertThat(jdbc.queryForObject(
                    "SELECT has_table_privilege('krug_app', ?, 'DELETE')", Boolean.class, name))
                    .as(name + " DELETE").isFalse();
        }
        assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM pg_indexes
                 WHERE schemaname = 'plugin'
                   AND indexname IN ('ix_plugin_polls_ws_chat_created',
                                     'ix_plugin_poll_options_ws_chat_poll',
                                     'ix_plugin_poll_votes_ws_chat_poll_option',
                                     'ix_plugin_tasks_ws_chat_done_created',
                                     'ix_plugin_tasks_ws_chat_assignee')
                """, Long.class)).isEqualTo(5L);
        assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'plugin'
                """, Long.class)).isZero();

        SessionResponse owner = devSession(uniqueDisplayName("actions-rls-owner"));
        SessionResponse stranger = devSession(uniqueDisplayName("actions-rls-stranger"));
        UUID workspaceId = owner.workspace().id();
        UUID chatId = owner.chat().id();
        assertOk(patchPlugin(owner, chatId, "polls", true));
        assertOk(patchPlugin(owner, chatId, "tasks", true));

        JsonNode poll = json(assertCreated(postPoll(owner, chatId,
                pollBody("Tenant?", "a", "b"))));
        JsonNode task = json(assertCreated(postTask(owner, chatId,
                Map.of("title", "Tenant task"))));
        String chatOption = poll.get("options").get(0).get("id").asText();

        // Same chat id from another tenant cannot see poll/task rows.
        Long polls = inTenant(stranger.user().id(), stranger.workspace().id(), () ->
                jdbc.queryForObject("SELECT count(*) FROM plugin.polls WHERE chat_id = ?",
                        Long.class, chatId));
        Long tasks = inTenant(stranger.user().id(), stranger.workspace().id(), () ->
                jdbc.queryForObject("SELECT count(*) FROM plugin.tasks WHERE chat_id = ?",
                        Long.class, chatId));
        assertThat(polls).isZero();
        assertThat(tasks).isZero();

        // WITH CHECK rejects a row whose workspace GUC does not match.
        assertThatThrownBy(() -> inTenant(owner.user().id(), workspaceId, () -> jdbc.update("""
                INSERT INTO plugin.polls (id, workspace_id, chat_id, creator_id, question)
                VALUES (?, ?, ?, ?, 'Leak?')
                """, UUID.randomUUID(), stranger.workspace().id(), chatId,
                owner.user().id()))).isInstanceOf(DataAccessException.class);

        // Composite FK: an option from another poll/workspace cannot receive a vote.
        JsonNode otherPoll = json(assertCreated(postPoll(owner, chatId,
                pollBody("Other tenant?", "x", "y"))));
        String otherOption = otherPoll.get("options").get(0).get("id").asText();
        assertThatThrownBy(() -> inTenant(owner.user().id(), workspaceId, () -> jdbc.update("""
                INSERT INTO plugin.poll_votes
                       (poll_id, option_id, workspace_id, chat_id, user_id)
                VALUES (?, ?, ?, ?, ?)
                """, UUID.fromString(poll.get("id").asText()),
                UUID.fromString(otherOption), workspaceId, chatId, owner.user().id())))
                .isInstanceOf(DataAccessException.class);

        // DB backstop for plain text.
        assertThatThrownBy(() -> migrator().update("""
                INSERT INTO plugin.polls (id, workspace_id, chat_id, creator_id, question)
                VALUES (?, ?, ?, ?, '<b>HTML</b>')
                """, UUID.randomUUID(), workspaceId, chatId, owner.user().id()))
                .isInstanceOf(DataAccessException.class);

        assertThat(task.get("title").asText()).isEqualTo("Tenant task");
        assertThat(chatOption).isNotBlank();
    }

    // ------------------------------------------------------------------

    private ResultActions patchPlugin(SessionResponse actor, UUID chatId, String pluginId,
                                      boolean enabled) throws Exception {
        return mockMvc.perform(authed(
                        patch("/api/v1/chats/{chatId}/plugins/{pluginId}", chatId, pluginId),
                        actor)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(Map.of("enabled", enabled))));
    }

    private ResultActions getPolls(SessionResponse actor, UUID chatId) throws Exception {
        return mockMvc.perform(authed(get("/api/v1/chats/{chatId}/polls", chatId), actor));
    }

    private JsonNode listPolls(SessionResponse actor, UUID chatId) throws Exception {
        MvcResult result = getPolls(actor, chatId).andExpect(status().isOk()).andReturn();
        return json(result);
    }

    private ResultActions postPoll(SessionResponse actor, UUID chatId, String body)
            throws Exception {
        return mockMvc.perform(authed(post("/api/v1/chats/{chatId}/polls", chatId), actor)
                .contentType(MediaType.APPLICATION_JSON)
                .content(body));
    }

    private ResultActions voteAction(SessionResponse actor, UUID chatId, String pollId,
                                     String optionId) throws Exception {
        return mockMvc.perform(authed(post(
                        "/api/v1/chats/{chatId}/polls/{pollId}/votes", chatId, pollId), actor)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(Map.of("option_id", optionId))));
    }

    private JsonNode vote(SessionResponse actor, UUID chatId, String pollId, String optionId)
            throws Exception {
        MvcResult result = voteAction(actor, chatId, pollId, optionId)
                .andExpect(status().isOk()).andReturn();
        return json(result);
    }

    private ResultActions closePoll(SessionResponse actor, UUID chatId, String pollId,
                                    boolean closed) throws Exception {
        return mockMvc.perform(authed(patch(
                        "/api/v1/chats/{chatId}/polls/{pollId}", chatId, pollId), actor)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(Map.of("closed", closed))));
    }

    private ResultActions getTasks(SessionResponse actor, UUID chatId) throws Exception {
        return mockMvc.perform(authed(get("/api/v1/chats/{chatId}/tasks", chatId), actor));
    }

    private ResultActions postTask(SessionResponse actor, UUID chatId,
                                   Map<String, Object> body) throws Exception {
        return mockMvc.perform(authed(post("/api/v1/chats/{chatId}/tasks", chatId), actor)
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

    private ResultActions translate(SessionResponse actor, UUID chatId, String messageId,
                                    String target) throws Exception {
        return mockMvc.perform(authed(post(
                        "/api/v1/chats/{chatId}/messages/{messageId}/translate", chatId,
                        messageId), actor)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(Map.of("target", target))));
    }

    private String pollBody(String question, String... options) throws Exception {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("question", question);
        body.put("options", List.of(options));
        return objectMapper.writeValueAsString(body);
    }

    private static long optionVotes(JsonNode poll, String optionId) {
        for (JsonNode option : poll.get("options")) {
            if (option.get("id").asText().equals(optionId)) {
                return option.get("votes").asLong();
            }
        }
        throw new AssertionError("option not found: " + optionId);
    }

    private UUID createGroup(SessionResponse owner) throws Exception {
        MvcResult result = mockMvc.perform(authed(
                        post("/api/v1/workspaces/{workspaceId}/chats", owner.workspace().id()),
                        owner)
                        .header("Idempotency-Key", UUID.randomUUID().toString())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "type", "GROUP",
                                "name", "actions-" + UUID.randomUUID()))))
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


    private MvcResult assertCreated(ResultActions actions) throws Exception {
        return actions.andExpect(status().isCreated()).andReturn();
    }

    private void assertError(ResultActions actions, int status, String code) throws Exception {
        MvcResult result = actions.andExpect(status().is(status)).andReturn();
        JsonNode body = json(result);
        CONTRACT.assertValid("Error", body);
        assertThat(body.get("code").asText()).as(body.toString()).isEqualTo(code);
    }

    private long pollCount(UUID chatId) {
        Long count = migrator().queryForObject(
                "SELECT count(*) FROM plugin.polls WHERE chat_id = ?", Long.class, chatId);
        return count == null ? 0 : count;
    }

    private long voteCount(String pollId) {
        Long count = migrator().queryForObject(
                "SELECT count(*) FROM plugin.poll_votes WHERE poll_id = ?", Long.class,
                UUID.fromString(pollId));
        return count == null ? 0 : count;
    }

    private Map<String, Object> pollVoteRow(String pollId, UUID userId) {
        return migrator().queryForMap("""
                SELECT option_id, created_at, updated_at FROM plugin.poll_votes
                 WHERE poll_id = ? AND user_id = ?
                """, UUID.fromString(pollId), userId);
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
