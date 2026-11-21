package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.LinkedHashMap;
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
 * D1.1 (#69) write side: chat OWNER/ADMIN authorization, idempotent toggles, audit
 * metadata (ids + boolean only), DB backstops and RLS. No plugin code is executed.
 */
@ActiveProfiles("test")
class ChatPluginsIT extends IntegrationTestBase {

    private static final OpenApiContract CONTRACT = OpenApiContract.load();

    @Autowired
    private TokenIssuer tokenIssuer;

    @Test
    void ownerTogglesPluginIdempotentlyAndStateIsPersisted() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("plugins-toggle"));
        UUID chatId = owner.chat().id();

        MvcResult enableResult = patchPlugin(owner, chatId, "polls", true)
                .andExpect(status().isOk())
                .andReturn();
        JsonNode enableBody = json(enableResult);
        CONTRACT.assertValid("ChatPluginState", enableBody);

        // The first PATCH already changed the row; the second was a no-op. Both return the
        // requested state and only one audit event exists.
        assertThat(enableBody.get("plugin_id").asText()).isEqualTo("polls");
        assertThat(enableBody.get("enabled").asBoolean()).isTrue();
        assertThat(enableBody.get("available").asBoolean()).isTrue();
        assertThat(enableBody.path("reason").isMissingNode()
                || enableBody.get("reason").isNull()).isTrue();
        assertThat(auditCount(chatId)).isEqualTo(1);

        Map<String, Object> row = toggleRow(chatId, "polls");
        assertThat(row.get("workspace_id")).isEqualTo(owner.workspace().id());
        assertThat(row.get("enabled")).isEqualTo(true);
        assertThat(row.get("updated_by")).isEqualTo(owner.user().id());
        assertThat(row.get("updated_at")).isNotNull();
        String updatedAt = String.valueOf(row.get("updated_at"));

        Map<String, Object> event = auditEvent(chatId);
        assertThat(event.get("actor_id")).isEqualTo(owner.user().id());
        assertThat(event.get("target_type")).isEqualTo("chat");
        assertThat(event.get("target_id")).isEqualTo(chatId);
        JsonNode metadata = objectMapper.readTree(String.valueOf(event.get("metadata")));
        assertThat(metadata.get("plugin_id").asText()).isEqualTo("polls");
        assertThat(metadata.get("enabled").asBoolean()).isTrue();
        assertThat(metadata.fieldNames()).toIterable()
                .containsExactlyInAnyOrder("plugin_id", "enabled");

        // A repeated identical PATCH is a 200 no-op: no new row, timestamp or audit.
        patchPlugin(owner, chatId, "polls", true).andExpect(status().isOk());
        assertThat(auditCount(chatId)).isEqualTo(1);
        assertThat(toggleCount(chatId)).isEqualTo(1);
        assertThat(String.valueOf(toggleRow(chatId, "polls").get("updated_at")))
                .isEqualTo(updatedAt);

        // The per-chat read reflects the stored row while other plugins stay default-off.
        JsonNode states = getStates(owner, chatId);
        assertThat(state(states, "polls").get("enabled").asBoolean()).isTrue();
        assertThat(state(states, "tasks").get("enabled").asBoolean()).isFalse();

        // Disable is a real change; repeating it is again idempotent.
        JsonNode disabled = json(patchPlugin(owner, chatId, "polls", false)
                .andExpect(status().isOk()).andReturn());
        assertThat(disabled.get("enabled").asBoolean()).isFalse();
        assertThat(toggleRow(chatId, "polls").get("enabled")).isEqualTo(false);
        assertThat(auditCount(chatId)).isEqualTo(2);
        patchPlugin(owner, chatId, "polls", false).andExpect(status().isOk());
        assertThat(auditCount(chatId)).isEqualTo(2);

        // Another plugin toggle is independent and adds one more audit event.
        patchPlugin(owner, chatId, "tasks", true).andExpect(status().isOk());
        assertThat(auditCount(chatId)).isEqualTo(3);
        assertThat(toggleCount(chatId)).isEqualTo(2);
    }

    @Test
    void onlyChatOwnerOrAdminMayChangePlugins() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("plugins-role-owner"));
        SessionResponse admin = devSession(uniqueDisplayName("plugins-role-admin"));
        SessionResponse moderator = devSession(uniqueDisplayName("plugins-role-mod"));
        SessionResponse member = devSession(uniqueDisplayName("plugins-role-member"));
        SessionResponse workspaceOnly = devSession(uniqueDisplayName("plugins-role-ws"));
        SessionResponse outsider = devSession(uniqueDisplayName("plugins-role-out"));
        UUID workspaceId = owner.workspace().id();
        UUID group = createGroup(owner);

        for (SessionResponse user : new SessionResponse[]{admin, moderator, member,
                workspaceOnly}) {
            joinWorkspace(workspaceId, user.user().id());
        }
        joinChat(group, workspaceId, admin.user().id(), "ADMIN");
        joinChat(group, workspaceId, moderator.user().id(), "MODERATOR");
        joinChat(group, workspaceId, member.user().id(), "MEMBER");

        SessionResponse adminInChat = scoped(admin, workspaceId);
        SessionResponse moderatorInChat = scoped(moderator, workspaceId);
        SessionResponse memberInChat = scoped(member, workspaceId);
        SessionResponse workspaceOnlyScoped = scoped(workspaceOnly, workspaceId);

        // A chat ADMIN may toggle even though the workspace role is MEMBER.
        MvcResult adminResult = patchPlugin(adminInChat, group, "polls", true)
                .andExpect(status().isOk()).andReturn();
        CONTRACT.assertValid("ChatPluginState", json(adminResult));
        assertThat(auditCount(group)).isEqualTo(1);
        assertThat(auditEvent(group).get("actor_id")).isEqualTo(admin.user().id());

        // MODERATOR and MEMBER are chat members but not managers.
        assertForbidden(patchPlugin(moderatorInChat, group, "tasks", true));
        assertForbidden(patchPlugin(memberInChat, group, "tasks", true));
        assertThat(auditCount(group)).isEqualTo(1);

        // A workspace member with no chat membership cannot read or write the chat.
        assertNotFound(getStatesActions(workspaceOnlyScoped, group));
        assertNotFound(patchPlugin(workspaceOnlyScoped, group, "tasks", true));
        // An outsider does not learn that the chat exists.
        assertNotFound(getStatesActions(outsider, group));
        assertNotFound(patchPlugin(outsider, group, "tasks", true));
        assertThat(auditCount(group)).isEqualTo(1);

        // Any ACTIVE chat member may read the state, including MEMBER and MODERATOR.
        CONTRACT.assertValid("ChatPluginStateList", getStates(memberInChat, group));
        CONTRACT.assertValid("ChatPluginStateList", getStates(moderatorInChat, group));
        assertThat(state(getStates(memberInChat, group), "polls").get("enabled").asBoolean())
                .isTrue();

        // A removed chat membership is treated as unknown.
        migrator().update("""
                UPDATE chat.chat_members SET status = 'REMOVED'
                 WHERE chat_id = ? AND user_id = ?
                """, group, member.user().id());
        assertNotFound(getStatesActions(memberInChat, group));
        assertNotFound(patchPlugin(memberInChat, group, "tasks", true));
    }

    @Test
    void unknownPluginIsNotFoundAndInvalidBodiesAreRejected() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("plugins-invalid"));
        UUID chatId = owner.chat().id();

        MvcResult unknown = patchPlugin(owner, chatId, "does-not-exist", true)
                .andExpect(status().isNotFound()).andReturn();
        JsonNode error = json(unknown);
        CONTRACT.assertValid("Error", error);
        assertThat(error.get("code").asText()).isEqualTo("PLUGIN_NOT_FOUND");
        assertThat(auditCount(chatId)).isZero();
        assertThat(toggleCount(chatId)).isZero();

        assertBadRequest(patchBody(owner, chatId, "polls", "{}"));
        assertBadRequest(patchBody(owner, chatId, "polls", "{\"enabled\":\"yes\"}"));
        assertBadRequest(patchBody(owner, chatId, "polls", ""));
        assertThat(toggleCount(chatId)).isZero();
        assertThat(auditCount(chatId)).isZero();

        MvcResult unknownChat = patchPlugin(owner, UUID.randomUUID(), "polls", true)
                .andExpect(status().isNotFound()).andReturn();
        CONTRACT.assertValid("Error", json(unknownChat));
        assertThat(json(unknownChat).get("code").asText()).isEqualTo("NOT_FOUND");

        // The plugin id is matched literally; a valid-looking unknown slug is a 404, not a
        // 500 or an empty 200.
        MvcResult other = patchPlugin(owner, chatId, "POLLS", true)
                .andExpect(status().isNotFound()).andReturn();
        assertThat(json(other).get("code").asText()).isEqualTo("PLUGIN_NOT_FOUND");
    }

    @Test
    void auditContainsOnlyPluginIdAndEnabled() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("plugins-audit"));
        UUID chatId = owner.chat().id();

        patchPlugin(owner, chatId, "polls", true).andExpect(status().isOk());
        patchPlugin(owner, chatId, "telegram", true).andExpect(status().isOk());

        var events = migrator().queryForList("""
                SELECT actor_id, action, target_type, target_id, metadata::text AS metadata
                  FROM audit.audit_events
                 WHERE action = 'chat.plugin.changed' AND target_id = ?
                 ORDER BY seq
                """, chatId);
        assertThat(events).hasSize(2);
        for (Map<String, Object> event : events) {
            assertThat(event.get("action")).isEqualTo("chat.plugin.changed");
            assertThat(event.get("actor_id")).isEqualTo(owner.user().id());
            assertThat(event.get("target_type")).isEqualTo("chat");
            assertThat(event.get("target_id")).isEqualTo(chatId);
            JsonNode metadata = objectMapper.readTree(String.valueOf(event.get("metadata")));
            assertThat(metadata.fieldNames()).toIterable()
                    .containsExactlyInAnyOrder("plugin_id", "enabled");
            // No catalog text, permission names, message content or secrets.
            String raw = String.valueOf(event.get("metadata"));
            assertThat(raw).doesNotContain("Опросы").doesNotContain("Голосования")
                    .doesNotContain("Telegram").doesNotContain("WEBHOOKS")
                    .doesNotContain("text");
        }
        assertThat(events.get(0).get("metadata")).isNotNull();
        assertThat(String.valueOf(events.get(0).get("metadata"))).contains("polls");
        assertThat(String.valueOf(events.get(1).get("metadata"))).contains("telegram");
    }

    @Test
    void catalogKillSwitchMakesPluginUnavailableAndBlocksToggle() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("plugins-kill-switch"));
        UUID chatId = owner.chat().id();

        migrator().update("UPDATE plugin.catalog SET state = 'DISABLED' WHERE id = 'translate'");
        try {
            JsonNode states = getStates(owner, chatId);
            JsonNode translate = state(states, "translate");
            assertThat(translate.get("available").asBoolean()).isFalse();
            assertThat(translate.get("reason").asText()).isEqualTo("PLUGIN_DISABLED");

            MvcResult blocked = patchPlugin(owner, chatId, "translate", true)
                    .andExpect(status().isUnprocessableEntity()).andReturn();
            JsonNode body = json(blocked);
            CONTRACT.assertValid("Error", body);
            assertThat(body.get("code").asText()).isEqualTo("PLUGIN_DISABLED");
            assertThat(body.get("details").get("plugin_id").asText()).isEqualTo("translate");
            assertThat(toggleCount(chatId)).isZero();
            assertThat(auditCount(chatId)).isZero();

            // Available plugins are unaffected by another row's kill switch.
            json(patchPlugin(owner, chatId, "polls", true).andExpect(status().isOk())
                    .andReturn());
            assertThat(auditCount(chatId)).isEqualTo(1);
        } finally {
            migrator().update("UPDATE plugin.catalog SET state = 'ACTIVE' WHERE id = 'translate'");
        }
    }

    @Test
    void schemaHasRlsGrantsSeedAndNoExecutionFunctions() throws Exception {
        assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM pg_tables
                 WHERE (schemaname = 'plugin' AND tablename = 'catalog')
                    OR (schemaname = 'chat' AND tablename = 'chat_plugins')
                """, Long.class)).isEqualTo(2L);
        assertThat(jdbc.queryForObject(
                "SELECT count(*) FROM plugin.catalog", Long.class)).isEqualTo(6L);
        assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM plugin.catalog
                 WHERE state = 'ACTIVE'
                   AND modes = ARRAY['MANAGED']::text[]
                   AND cardinality(permissions) > 0
                """, Long.class)).isEqualTo(6L);

        Map<String, Object> catalogFlags = jdbc.queryForMap("""
                SELECT relrowsecurity, relforcerowsecurity FROM pg_class
                 WHERE oid = 'plugin.catalog'::regclass
                """);
        Map<String, Object> chatFlags = jdbc.queryForMap("""
                SELECT relrowsecurity, relforcerowsecurity FROM pg_class
                 WHERE oid = 'chat.chat_plugins'::regclass
                """);
        // #86: the catalog keeps a global read policy but application writes are
        // restricted by RLS to kind='EXTERNAL' rows (built-ins stay migrator-only).
        assertThat(catalogFlags.get("relrowsecurity")).isEqualTo(true);
        assertThat(catalogFlags.get("relforcerowsecurity")).isEqualTo(false);
        assertThat(chatFlags.get("relrowsecurity")).isEqualTo(true);
        assertThat(chatFlags.get("relforcerowsecurity")).isEqualTo(true);

        assertThat(jdbc.queryForObject(
                "SELECT has_table_privilege('krug_app', 'plugin.catalog', 'SELECT')",
                Boolean.class)).isTrue();
        for (String privilege : new String[]{"INSERT", "UPDATE", "DELETE"}) {
            assertThat(jdbc.queryForObject(
                    "SELECT has_table_privilege('krug_app', 'plugin.catalog', ?)",
                    Boolean.class, privilege)).as(privilege).isTrue();
        }
        for (String privilege : new String[]{"SELECT", "INSERT", "UPDATE", "DELETE"}) {
            assertThat(jdbc.queryForObject(
                    "SELECT has_table_privilege('krug_app', 'chat.chat_plugins', ?)",
                    Boolean.class, privilege)).as(privilege).isTrue();
        }

        assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM pg_constraint
                 WHERE conrelid = 'chat.chat_plugins'::regclass AND contype = 'p'
                """, Long.class)).isEqualTo(1L);
        assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM pg_constraint
                 WHERE conrelid = 'chat.chat_plugins'::regclass AND contype = 'f'
                """, Long.class)).isEqualTo(2L);
        assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM pg_indexes
                 WHERE schemaname = 'chat'
                   AND indexname IN ('ix_chat_plugins_workspace_chat',
                                     'ix_chat_plugins_plugin')
                """, Long.class)).isEqualTo(2L);

        // Catalog rows are metadata only: no functions (execution hooks) in the schema.
        assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM pg_proc p
                  JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'plugin'
                """, Long.class)).isZero();

        // DB backstop: unknown modes cannot be inserted even through direct SQL.
        assertThatThrownBy(() -> migrator().update("""
                INSERT INTO plugin.catalog (id, name, description, modes)
                VALUES ('bogus', 'Bogus', 'Bogus', ARRAY['BOGUS']::text[])
                """)).isInstanceOf(DataAccessException.class);

        // RLS isolation: a row written in one tenant is invisible from another.
        SessionResponse owner = devSession(uniqueDisplayName("plugins-rls-owner"));
        SessionResponse stranger = devSession(uniqueDisplayName("plugins-rls-stranger"));
        UUID chatId = owner.chat().id();
        UUID workspaceId = owner.workspace().id();
        inTenant(owner.user().id(), workspaceId, () -> jdbc.update("""
                INSERT INTO chat.chat_plugins
                       (workspace_id, chat_id, plugin_id, enabled, updated_by)
                VALUES (?, ?, 'polls', true, ?)
                """, workspaceId, chatId, owner.user().id()));
        Long visible = inTenant(stranger.user().id(), stranger.workspace().id(), () ->
                jdbc.queryForObject("SELECT count(*) FROM chat.chat_plugins WHERE chat_id = ?",
                        Long.class, chatId));
        assertThat(visible).isZero();
        assertThatThrownBy(() -> inTenant(owner.user().id(), workspaceId, () -> jdbc.update("""
                INSERT INTO chat.chat_plugins
                       (workspace_id, chat_id, plugin_id, enabled, updated_by)
                VALUES (?, ?, 'tasks', true, ?)
                """, stranger.workspace().id(), chatId, owner.user().id())))
                .isInstanceOf(DataAccessException.class);
    }

    // ------------------------------------------------------------------

    private ResultActions patchPlugin(SessionResponse actor, UUID chatId, String pluginId,
                                      boolean enabled) throws Exception {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("enabled", enabled);
        return patchBody(actor, chatId, pluginId, objectMapper.writeValueAsString(body));
    }

    private ResultActions patchBody(SessionResponse actor, UUID chatId, String pluginId,
                                    String body) throws Exception {
        return mockMvc.perform(authed(
                        patch("/api/v1/chats/{chatId}/plugins/{pluginId}", chatId, pluginId),
                        actor)
                .contentType(MediaType.APPLICATION_JSON)
                .content(body));
    }

    private ResultActions getStatesActions(SessionResponse actor, UUID chatId) throws Exception {
        return mockMvc.perform(authed(
                get("/api/v1/chats/{chatId}/plugins", chatId), actor));
    }

    private JsonNode getStates(SessionResponse actor, UUID chatId) throws Exception {
        MvcResult result = getStatesActions(actor, chatId)
                .andExpect(status().isOk())
                .andReturn();
        return json(result);
    }

    private UUID createGroup(SessionResponse owner) throws Exception {
        MvcResult result = mockMvc.perform(authed(
                        post("/api/v1/workspaces/{workspaceId}/chats", owner.workspace().id()),
                        owner)
                        .header("Idempotency-Key", UUID.randomUUID().toString())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "type", "GROUP",
                                "name", "plugins-" + UUID.randomUUID()))))
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

    private JsonNode state(JsonNode states, String pluginId) {
        for (JsonNode item : states.get("items")) {
            if (pluginId.equals(item.get("plugin_id").asText())) {
                return item;
            }
        }
        throw new AssertionError("state not found: " + pluginId);
    }

    private Map<String, Object> toggleRow(UUID chatId, String pluginId) {
        return migrator().queryForMap("""
                SELECT workspace_id, enabled, updated_by, updated_at
                  FROM chat.chat_plugins
                 WHERE chat_id = ? AND plugin_id = ?
                """, chatId, pluginId);
    }

    private long toggleCount(UUID chatId) {
        Long count = migrator().queryForObject(
                "SELECT count(*) FROM chat.chat_plugins WHERE chat_id = ?", Long.class, chatId);
        return count == null ? 0 : count;
    }

    private Map<String, Object> auditEvent(UUID chatId) {
        return migrator().queryForMap("""
                SELECT actor_id, action, target_type, target_id, metadata::text AS metadata
                  FROM audit.audit_events
                 WHERE action = 'chat.plugin.changed' AND target_id = ?
                 ORDER BY seq
                 LIMIT 1
                """, chatId);
    }

    private long auditCount(UUID chatId) {
        Long count = migrator().queryForObject("""
                SELECT count(*) FROM audit.audit_events
                 WHERE action = 'chat.plugin.changed' AND target_id = ?
                """, Long.class, chatId);
        return count == null ? 0 : count;
    }

    private void assertForbidden(ResultActions actions) throws Exception {
        MvcResult result = actions.andExpect(status().isForbidden()).andReturn();
        JsonNode body = json(result);
        CONTRACT.assertValid("Error", body);
        assertThat(body.get("code").asText()).isEqualTo("FORBIDDEN");
    }

    private void assertNotFound(ResultActions actions) throws Exception {
        MvcResult result = actions.andExpect(status().isNotFound()).andReturn();
        JsonNode body = json(result);
        CONTRACT.assertValid("Error", body);
        assertThat(body.get("code").asText()).isEqualTo("NOT_FOUND");
    }

    private void assertBadRequest(ResultActions actions) throws Exception {
        MvcResult result = actions.andExpect(status().isBadRequest()).andReturn();
        JsonNode body = json(result);
        CONTRACT.assertValid("Error", body);
        assertThat(body.get("code").asText()).isEqualTo("VALIDATION_FAILED");
    }
}
