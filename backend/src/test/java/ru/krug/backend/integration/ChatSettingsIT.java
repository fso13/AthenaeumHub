package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataAccessException;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.ResultActions;

import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.support.IntegrationTestBase;
import ru.krug.backend.support.OpenApiContract;

/**
 * D1-BE3 end-to-end: {@code PATCH /chats/{chatId}} (name/description), workspace-role
 * authorization, plain-text validation, audit metadata (field names only), DB backstops
 * and the V30 scope lookup.
 */
@ActiveProfiles("test")
class ChatSettingsIT extends IntegrationTestBase {

    private static final OpenApiContract CONTRACT = OpenApiContract.load();

    @Test
    void ownerUpdatesNameAndDescriptionAndAuditHasOnlyFieldNames() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("d1be3-owner"));
        UUID chatId = owner.chat().id();

        MvcResult updated = patchChat(owner, chatId, Map.of(
                        "name", "  Product   Team  ",
                        "description", "  hello\r\nworld  "))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode body = json(updated);
        CONTRACT.assertValid("Chat", body);
        assertThat(body.get("id").asText()).isEqualTo(chatId.toString());
        assertThat(body.get("name").asText()).isEqualTo("Product Team");
        assertThat(body.get("description").asText()).isEqualTo("hello\nworld");
        assertThat(body.get("security_mode").asText()).isEqualTo("MANAGED");
        assertThat(body.get("created_at").asText()).isNotBlank();

        // The list view carries the same additive description field.
        JsonNode chat = chatInList(owner, chatId);
        assertThat(chat.get("name").asText()).isEqualTo("Product Team");
        assertThat(chat.get("description").asText()).isEqualTo("hello\nworld");

        Map<String, Object> event = auditEvent(chatId);
        assertThat(event.get("actor_id")).isEqualTo(owner.user().id());
        assertThat(event.get("target_type")).isEqualTo("chat");
        String metadata = String.valueOf(event.get("metadata"));
        assertThat(metadata).contains("\"fields\"").contains("name").contains("description");
        assertThat(metadata)
                .doesNotContain("Product Team")
                .doesNotContain("hello")
                .doesNotContain("world");

        // description: "" clears it to null; name is untouched.
        MvcResult cleared = patchChat(owner, chatId, Map.of("description", ""))
                .andExpect(status().isOk())
                .andReturn();
        CONTRACT.assertValid("Chat", json(cleared));
        assertThat(json(cleared).get("name").asText()).isEqualTo("Product Team");
        assertThat(json(cleared).get("description").isNull()).isTrue();
        assertThat(chatInList(owner, chatId).get("description").isNull()).isTrue();
        assertThat(auditCount(chatId)).isEqualTo(2);

        // A description-only patch leaves the name alone; a name-only patch leaves the
        // description alone.
        patchChat(owner, chatId, Map.of("description", "  next  ")).andExpect(status().isOk());
        MvcResult renamed = patchChat(owner, chatId, Map.of("name", "Renamed"))
                .andExpect(status().isOk()).andReturn();
        assertThat(json(renamed).get("name").asText()).isEqualTo("Renamed");
        assertThat(json(renamed).get("description").asText()).isEqualTo("next");
    }

    @Test
    void invalidSettingsAreRejectedWithoutSideEffects() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("d1be3-invalid"));
        UUID chatId = owner.chat().id();
        String originalName = owner.chat().name();

        assertValidationError(patchChat(owner, chatId, Map.of("name", "x".repeat(121))),
                "name", null);
        assertValidationError(patchChat(owner, chatId, Map.of("name", "   ")), "name", null);
        assertValidationError(patchChat(owner, chatId, Map.of("name", "<b>chat</b>")),
                "name", null);
        assertValidationError(patchChat(owner, chatId, Map.of("description", "x".repeat(501))),
                "description", null);
        assertValidationError(patchChat(owner, chatId, Map.of("description", "<script>x</script>")),
                "description", null);
        assertValidationError(patchChat(owner, chatId, Map.of()), null, "empty_patch");
        // Empty description is not an error: it clears the value. But a patch with only
        // null/absent field is an empty patch.
        patchChat(owner, chatId, Map.of("description", "ok")).andExpect(status().isOk());
        long audits = auditCount(chatId);
        assertValidationError(patchChat(owner, chatId, Map.of()), null, "empty_patch");

        Map<String, Object> row = migrator().queryForMap(
                "SELECT name, description FROM chat.chats WHERE id = ?", chatId);
        assertThat(row.get("name")).isEqualTo(originalName);
        assertThat(row.get("description")).isEqualTo("ok");
        assertThat(auditCount(chatId)).isEqualTo(audits);
        assertThat(auditCount(chatId)).isEqualTo(1);

        // Unknown, deleted and foreign chats are hidden as 404.
        MvcResult unknown = patchChat(owner, UUID.randomUUID(), Map.of("name", "nope"))
                .andExpect(status().isNotFound()).andReturn();
        CONTRACT.assertValid("Error", json(unknown));
        assertThat(json(unknown).get("code").asText()).isEqualTo("NOT_FOUND");

        SessionResponse stranger = devSession(uniqueDisplayName("d1be3-stranger"));
        MvcResult foreign = patchChat(owner, stranger.chat().id(), Map.of("name", "nope"))
                .andExpect(status().isNotFound()).andReturn();
        assertThat(json(foreign).get("code").asText()).isEqualTo("NOT_FOUND");

        migrator().update("UPDATE chat.chats SET deleted_at = now() WHERE id = ?", chatId);
        patchChat(owner, chatId, Map.of("name", "nope")).andExpect(status().isNotFound());
    }

    @Test
    void onlyWorkspaceOwnerOrAdminMayEditSettings() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("d1be3-role-owner"));
        SessionResponse member = devSession(uniqueDisplayName("d1be3-role-member"));
        SessionResponse guest = devSession(uniqueDisplayName("d1be3-role-guest"));
        SessionResponse outsider = devSession(uniqueDisplayName("d1be3-role-outsider"));
        UUID workspaceId = owner.workspace().id();
        UUID chatId = owner.chat().id();

        addMember(owner, workspaceId, emailOf(member.user().id()), "MEMBER")
                .andExpect(status().isCreated());
        addMember(owner, workspaceId, emailOf(guest.user().id()), "GUEST")
                .andExpect(status().isCreated());

        assertForbidden(patchChat(member, chatId, Map.of("name", "member-name")));
        assertForbidden(patchChat(guest, chatId, Map.of("name", "guest-name")));
        // Outsiders do not even learn that the chat exists.
        MvcResult outsiderResult = patchChat(outsider, chatId, Map.of("name", "outside"))
                .andExpect(status().isNotFound()).andReturn();
        assertThat(json(outsiderResult).get("code").asText()).isEqualTo("NOT_FOUND");

        assertThat(currentName(chatId)).isEqualTo(owner.chat().name());
        assertThat(auditCount(chatId)).isZero();

        // Promote MEMBER -> ADMIN: workspace role is what matters, chat membership is not
        // required (the admin was added after the chat was created).
        mockMvc.perform(authed(
                        patch("/api/v1/workspaces/{workspaceId}/members/{userId}",
                                workspaceId, member.user().id()), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("role", "ADMIN"))))
                .andExpect(status().isOk());

        MvcResult promoted = patchChat(member, chatId, Map.of("name", "admin-name"))
                .andExpect(status().isOk()).andReturn();
        CONTRACT.assertValid("Chat", json(promoted));
        assertThat(json(promoted).get("name").asText()).isEqualTo("admin-name");
        assertThat(currentName(chatId)).isEqualTo("admin-name");

        Map<String, Object> event = auditEvent(chatId);
        assertThat(event.get("actor_id")).isEqualTo(member.user().id());
        assertThat(String.valueOf(event.get("metadata"))).contains("name")
                .doesNotContain("admin-name");

        // ADMIN may not edit a chat in another workspace (no membership there).
        SessionResponse otherOwner = devSession(uniqueDisplayName("d1be3-other-owner"));
        MvcResult other = patchChat(member, otherOwner.chat().id(), Map.of("name", "x"))
                .andExpect(status().isNotFound()).andReturn();
        assertThat(json(other).get("code").asText()).isEqualTo("NOT_FOUND");
    }

    @Test
    void settingsScopeAndDatabaseBackstopsAreSafe() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("d1be3-db-owner"));
        SessionResponse member = devSession(uniqueDisplayName("d1be3-db-member"));
        SessionResponse outsider = devSession(uniqueDisplayName("d1be3-db-outsider"));
        UUID workspaceId = owner.workspace().id();
        UUID chatId = owner.chat().id();
        addMember(owner, workspaceId, emailOf(member.user().id()), "MEMBER")
                .andExpect(status().isCreated());

        String ownerRole = inTenant(owner.user().id(), workspaceId, () ->
                jdbc.queryForObject("""
                        SELECT workspace_role FROM chat.settings_scope(
                            CAST(? AS uuid), CAST(? AS uuid))
                        """, String.class, chatId, owner.user().id()));
        assertThat(ownerRole).isEqualTo("OWNER");
        String memberRole = inTenant(member.user().id(), workspaceId, () ->
                jdbc.queryForObject("""
                        SELECT workspace_role FROM chat.settings_scope(
                            CAST(? AS uuid), CAST(? AS uuid))
                        """, String.class, chatId, member.user().id()));
        assertThat(memberRole).isEqualTo("MEMBER");

        Long outsiderRows = inTenant(outsider.user().id(), outsider.workspace().id(), () ->
                jdbc.queryForObject("""
                        SELECT count(*) FROM chat.settings_scope(
                            CAST(? AS uuid), CAST(? AS uuid))
                        """, Long.class, chatId, outsider.user().id()));
        assertThat(outsiderRows).isZero();

        // A caller cannot spoof another principal: the function also requires the actor
        // to match ops.current_user_id().
        Long spoofed = inTenant(outsider.user().id(), outsider.workspace().id(), () ->
                jdbc.queryForObject("""
                        SELECT count(*) FROM chat.settings_scope(
                            CAST(? AS uuid), CAST(? AS uuid))
                        """, Long.class, chatId, owner.user().id()));
        assertThat(spoofed).isZero();

        Map<String, Object> function = migrator().queryForMap("""
                SELECT p.prosecdef,
                       has_function_privilege('public', p.oid, 'EXECUTE') AS public_execute,
                       has_function_privilege('krug_app', p.oid, 'EXECUTE') AS app_execute
                  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'chat' AND p.proname = 'settings_scope'
                """);
        assertThat(function.get("prosecdef")).isEqualTo(true);
        assertThat(function.get("public_execute")).isEqualTo(false);
        assertThat(function.get("app_execute")).isEqualTo(true);

        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM pg_constraint
                 WHERE conrelid = 'chat.chats'::regclass
                   AND conname IN ('ck_chats_name_length', 'ck_chats_description_length')
                   AND convalidated
                """, Long.class)).isEqualTo(2L);
        assertThatThrownBy(() -> migrator().update(
                "UPDATE chat.chats SET description = ? WHERE id = ?", "x".repeat(501), chatId))
                .isInstanceOf(DataAccessException.class)
                .hasStackTraceContaining("ck_chats_description_length");
        assertThatThrownBy(() -> migrator().update(
                "UPDATE chat.chats SET name = ? WHERE id = ?", "x".repeat(121), chatId))
                .isInstanceOf(DataAccessException.class)
                .hasStackTraceContaining("ck_chats_name_length");

        // RLS still hides the chat from a different tenant.
        Long visible = inTenant(outsider.user().id(), outsider.workspace().id(), () ->
                jdbc.queryForObject("SELECT count(*) FROM chat.chats WHERE id = ?",
                        Long.class, chatId));
        assertThat(visible).isZero();
    }

    // ------------------------------------------------------------------

    private ResultActions patchChat(SessionResponse actor, UUID chatId,
                                    Map<String, Object> body) throws Exception {
        return mockMvc.perform(authed(patch("/api/v1/chats/{chatId}", chatId), actor)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(body)));
    }

    private ResultActions addMember(SessionResponse owner, UUID workspaceId, String email,
                                    String role) throws Exception {
        return mockMvc.perform(authed(
                        post("/api/v1/workspaces/{workspaceId}/members", workspaceId), owner)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(Map.of(
                        "email", email, "role", role))));
    }

    private JsonNode chatInList(SessionResponse session, UUID chatId) throws Exception {
        for (JsonNode item : chatList(session).get("items")) {
            if (item.get("id").asText().equals(chatId.toString())) {
                return item;
            }
        }
        throw new AssertionError("chat not found in list: " + chatId);
    }

    private String currentName(UUID chatId) {
        return migrator().queryForObject("SELECT name FROM chat.chats WHERE id = ?",
                String.class, chatId);
    }

    private String emailOf(UUID userId) {
        return migrator().queryForObject(
                "SELECT email::text FROM auth.users WHERE id = ?", String.class, userId);
    }

    private Map<String, Object> auditEvent(UUID chatId) {
        return migrator().queryForMap("""
                SELECT actor_id, target_type, target_id, metadata::text AS metadata
                  FROM audit.audit_events
                 WHERE action = 'chat.updated' AND target_id = ?
                 ORDER BY created_at DESC, id DESC
                 LIMIT 1
                """, chatId);
    }

    private long auditCount(UUID chatId) {
        Long count = migrator().queryForObject("""
                SELECT count(*) FROM audit.audit_events
                 WHERE action = 'chat.updated' AND target_id = ?
                """, Long.class, chatId);
        return count == null ? 0 : count;
    }

    private void assertForbidden(ResultActions actions) throws Exception {
        MvcResult result = actions.andExpect(status().isForbidden()).andReturn();
        CONTRACT.assertValid("Error", json(result));
        assertThat(json(result).get("code").asText()).isEqualTo("FORBIDDEN");
    }

    private void assertValidationError(ResultActions actions, String field, String reason)
            throws Exception {
        MvcResult result = actions.andExpect(status().isUnprocessableEntity()).andReturn();
        JsonNode body = json(result);
        CONTRACT.assertValid("Error", body);
        assertThat(body.get("code").asText()).isEqualTo("VALIDATION_FAILED");
        if (field != null) {
            assertThat(body.at("/details/field").asText()).isEqualTo(field);
        }
        if (reason != null) {
            assertThat(body.at("/details/reason").asText()).isEqualTo(reason);
        }
    }
}
