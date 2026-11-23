package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.ResultActions;

import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.support.IntegrationTestBase;
import ru.krug.backend.support.OpenApiContract;

/**
 * #99 workspace lifecycle end-to-end.
 *
 * <p>Covers self-leave (member/admin/guest, sole owner, idempotency, lost list/chat/session
 * access), owner soft-delete (status/deleted_at, memberships/invites/chat participants,
 * bots, retained messages, idempotency, permissions, cross-tenant), the SECURITY DEFINER
 * backstops and the exact chat {@code member_count} for GROUP/DIRECT/PRIVATE channels.</p>
 */
@ActiveProfiles("test")
class WorkspaceLifecycleIT extends IntegrationTestBase {

    private static final OpenApiContract CONTRACT = OpenApiContract.load();

    @Test
    void memberLeavesAndLosesWorkspaceAndChatAccess() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("e99-leave-owner"));
        SessionResponse member = devSession(uniqueDisplayName("e99-leave-member"));
        UUID workspaceId = owner.workspace().id();
        addMember(owner, workspaceId, emailOf(member.user().id()), "MEMBER")
                .andExpect(status().isCreated());

        // Before leave the member sees the workspace and the default PUBLIC chat (2 members).
        assertThat(chatMemberCount(member, workspaceId, owner.chat().id()))
                .isEqualTo(2);
        mockMvc.perform(authed(get("/api/v1/workspaces/{workspaceId}/members", workspaceId),
                        member))
                .andExpect(status().isOk());

        leave(member, workspaceId)
                .andExpect(status().isNoContent());

        Map<String, Object> membership = membership(workspaceId, member.user().id());
        assertThat(membership.get("status")).isEqualTo("REMOVED");
        assertThat(membership.get("role")).isEqualTo("MEMBER");
        assertThat(membership.get("joined_at")).isNotNull();
        assertThat(chatParticipantStatus(workspaceId, member.user().id()))
                .containsOnly("REMOVED");

        Map<String, Object> event = auditEvent("workspace.member.left", member.user().id());
        assertThat(event.get("actor_id")).isEqualTo(member.user().id());
        assertThat(event.get("target_type")).isEqualTo("user");
        assertThat(String.valueOf(event.get("metadata")))
                .contains("MEMBER").contains("chat_memberships_removed")
                .doesNotContain(emailOf(member.user().id()))
                .doesNotContain(member.user().displayName());

        // The member loses the workspace: chat list, members, sessions and /me membership.
        assertForbidden(mockMvc.perform(authed(
                get("/api/v1/workspaces/{workspaceId}/chats", workspaceId), member)));
        assertForbidden(mockMvc.perform(authed(
                get("/api/v1/workspaces/{workspaceId}/members", workspaceId), member)));
        assertForbidden(mockMvc.perform(authed(
                get("/api/v1/workspaces/{workspaceId}/sessions", workspaceId), member)));
        assertThat(workspaceIds(getMe(member))).doesNotContain(workspaceId.toString());

        // The owner keeps the workspace; the exact chat count dropped immediately.
        assertThat(chatMemberCount(owner, workspaceId, owner.chat().id()))
                .isEqualTo(1);
        assertThat(userIds(members(owner, workspaceId)))
                .containsExactly(owner.user().id());

        // A repeated leave (or a leave after an administrator removal) is 204 without audit.
        long eventsBefore = auditCount("workspace.member.left", member.user().id());
        leave(member, workspaceId).andExpect(status().isNoContent());
        assertThat(auditCount("workspace.member.left", member.user().id()))
                .isEqualTo(eventsBefore);
    }

    @Test
    void soleOwnerCannotLeave() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("e99-owner-leave"));
        UUID workspaceId = owner.workspace().id();

        MvcResult result = leave(owner, workspaceId)
                .andExpect(status().isConflict())
                .andReturn();
        JsonNode error = json(result);
        CONTRACT.assertValid("Error", error);
        assertThat(error.get("code").asText()).isEqualTo("LAST_OWNER");

        assertThat(membership(workspaceId, owner.user().id()).get("status")).isEqualTo("ACTIVE");
        assertThat(auditCount("workspace.member.left", owner.user().id())).isZero();
        mockMvc.perform(authed(get("/api/v1/workspaces/{workspaceId}/chats", workspaceId),
                        owner))
                .andExpect(status().isOk());
    }

    @Test
    void permissionsAndIdempotencyAreEnforcedForLeaveAndDelete() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("e99-perm-owner"));
        SessionResponse admin = devSession(uniqueDisplayName("e99-perm-admin"));
        SessionResponse member = devSession(uniqueDisplayName("e99-perm-member"));
        SessionResponse guest = devSession(uniqueDisplayName("e99-perm-guest"));
        SessionResponse outsider = devSession(uniqueDisplayName("e99-perm-outsider"));
        UUID workspaceId = owner.workspace().id();
        addMember(owner, workspaceId, emailOf(admin.user().id()), "ADMIN")
                .andExpect(status().isCreated());
        addMember(owner, workspaceId, emailOf(member.user().id()), "MEMBER")
                .andExpect(status().isCreated());
        addMember(owner, workspaceId, emailOf(guest.user().id()), "GUEST")
                .andExpect(status().isCreated());

        // Outsider and unknown workspace are indistinguishable 403 (no existence leak).
        assertForbidden(leave(outsider, workspaceId));
        assertForbidden(leave(outsider, UUID.randomUUID()));
        assertForbidden(deleteWorkspace(outsider, workspaceId));
        assertForbidden(deleteWorkspace(outsider, UUID.randomUUID()));

        // An ACTIVE non-owner cannot delete; a member cannot manage the workspace either.
        assertForbiddenCode(deleteWorkspace(member, workspaceId),
                "WORKSPACE_PERMISSION_DENIED");
        assertForbiddenCode(deleteWorkspace(admin, workspaceId),
                "WORKSPACE_PERMISSION_DENIED");
        assertForbidden(deleteWorkspace(member, UUID.randomUUID()));

        // Denied calls changed nothing.
        assertThat(workspaceStatus(workspaceId)).isEqualTo("ACTIVE");
        assertThat(membership(workspaceId, member.user().id()).get("status"))
                .isEqualTo("ACTIVE");
        assertThat(auditCount("workspace.deleted", workspaceId)).isZero();

        // A GUEST may leave, and a repeat is an idempotent 204.
        leave(guest, workspaceId).andExpect(status().isNoContent());
        leave(guest, workspaceId).andExpect(status().isNoContent());
        assertThat(membership(workspaceId, guest.user().id()).get("status"))
                .isEqualTo("REMOVED");
        assertThat(auditCount("workspace.member.left", guest.user().id())).isEqualTo(1);
    }

    @Test
    void ownerDeletesWorkspaceSoftlyAndContentIsRetained() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("e99-delete-owner"));
        SessionResponse member = devSession(uniqueDisplayName("e99-delete-member"));
        SessionResponse outsider = devSession(uniqueDisplayName("e99-delete-outsider"));
        UUID workspaceId = owner.workspace().id();
        UUID chatId = owner.chat().id();
        addMember(owner, workspaceId, emailOf(member.user().id()), "MEMBER")
                .andExpect(status().isCreated());

        // A real message and a bot message prove that content survives the soft delete.
        sendMessage(owner, chatId, UUID.randomUUID().toString(),
                UUID.randomUUID().toString(), "retained-before-delete");
        UUID botId = createBot(owner, workspaceId);
        String botToken = botToken(owner, workspaceId, botId);
        installBot(owner, chatId, botId).andExpect(status().isCreated());
        mockMvc.perform(post("/api/v1/bots/{botId}/messages", botId)
                        .header("Authorization", "Bearer " + botToken)
                        .header("Idempotency-Key", UUID.randomUUID().toString())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "chat_id", chatId.toString(), "text", "bot-before-delete"))))
                .andExpect(status().isCreated());
        long messagesBefore = messageCount(chatId);

        String inviteToken = createInviteToken(owner, workspaceId);

        deleteWorkspace(owner, workspaceId).andExpect(status().isNoContent());

        Map<String, Object> workspace = migrator().queryForMap("""
                SELECT status, deleted_at, deleted_by
                  FROM workspace.workspaces WHERE id = ?
                """, workspaceId);
        assertThat(workspace.get("status")).isEqualTo("DELETED");
        assertThat(workspace.get("deleted_at")).isNotNull();
        assertThat(workspace.get("deleted_by")).isEqualTo(owner.user().id());
        assertThat(membershipStatuses(workspaceId)).containsOnly("REMOVED");
        assertThat(inviteRevokedAt(workspaceId)).isNotNull();
        assertThat(chatParticipantStatuses(workspaceId)).containsOnly("REMOVED");
        assertThat(botStatus(workspaceId)).isEqualTo("DISABLED");
        // Chat and message rows are deliberately retained; only API access is gone.
        assertThat(chatDeletedAt(chatId)).isNull();
        assertThat(messageCount(chatId)).isEqualTo(messagesBefore);

        Map<String, Object> event = auditEvent("workspace.deleted", workspaceId);
        assertThat(event.get("actor_id")).isEqualTo(owner.user().id());
        assertThat(event.get("target_type")).isEqualTo("workspace");
        assertThat(String.valueOf(event.get("metadata")))
                .contains("memberships_removed").contains("invites_revoked")
                .contains("chat_memberships_removed").contains("bots_disabled")
                .doesNotContain(owner.user().displayName())
                .doesNotContain(member.user().displayName());

        // Every participant loses the workspace, and the invite is unusable.
        assertForbidden(mockMvc.perform(authed(
                get("/api/v1/workspaces/{workspaceId}/chats", workspaceId), owner)));
        assertForbidden(mockMvc.perform(authed(
                get("/api/v1/workspaces/{workspaceId}/chats", workspaceId), member)));
        assertForbidden(mockMvc.perform(authed(
                get("/api/v1/workspaces/{workspaceId}/sessions", workspaceId), owner)));
        assertThat(workspaceIds(getMe(owner))).doesNotContain(workspaceId.toString());
        assertThat(workspaceIds(getMe(member))).doesNotContain(workspaceId.toString());
        mockMvc.perform(post("/api/v1/workspace-invites/{token}/accept", inviteToken)
                        .header("Authorization", "Bearer " + outsider.accessToken())
                        .header("X-Device-Id", outsider.device().id().toString()))
                .andExpect(status().isNotFound());

        // A disabled bot can no longer authenticate / write (its token is not enough).
        mockMvc.perform(post("/api/v1/bots/{botId}/messages", botId)
                        .header("Authorization", "Bearer " + botToken)
                        .header("Idempotency-Key", UUID.randomUUID().toString())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "chat_id", chatId.toString(), "text", "after-delete"))))
                .andExpect(status().isUnauthorized());

        // Repeated owner delete is an idempotent 204 without a second audit event.
        long deletes = auditCount("workspace.deleted", workspaceId);
        deleteWorkspace(owner, workspaceId).andExpect(status().isNoContent());
        assertThat(auditCount("workspace.deleted", workspaceId)).isEqualTo(deletes);
        assertForbidden(deleteWorkspace(outsider, workspaceId));
    }

    @Test
    void chatMemberCountIsExactForGroupDirectAndPrivate() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("e99-count-owner"));
        SessionResponse first = devSession(uniqueDisplayName("e99-count-first"));
        SessionResponse second = devSession(uniqueDisplayName("e99-count-second"));
        UUID workspaceId = owner.workspace().id();
        UUID defaultChatId = owner.chat().id();
        addMember(owner, workspaceId, emailOf(first.user().id()), "MEMBER")
                .andExpect(status().isCreated());
        addMember(owner, workspaceId, emailOf(second.user().id()), "MEMBER")
                .andExpect(status().isCreated());

        // PUBLIC default channel: all three ACTIVE workspace members.
        assertThat(chatMemberCount(owner, workspaceId, defaultChatId)).isEqualTo(3);

        MvcResult direct = createChat(owner, workspaceId, Map.of(
                "type", "DIRECT", "peer_id", first.user().id().toString()));
        JsonNode directNode = json(direct);
        CONTRACT.assertValid("Chat", directNode);
        assertThat(directNode.get("member_count").asInt()).isEqualTo(2);
        UUID directChatId = UUID.fromString(directNode.get("id").asText());

        MvcResult privateGroup = createChat(owner, workspaceId, groupBody(
                "private-" + UUID.randomUUID(), "PRIVATE", second.user().id()));
        JsonNode privateNode = json(privateGroup);
        CONTRACT.assertValid("Chat", privateNode);
        assertThat(privateNode.get("member_count").asInt()).isEqualTo(2);
        UUID privateChatId = UUID.fromString(privateNode.get("id").asText());

        MvcResult publicGroup = createChat(owner, workspaceId, groupBody(
                "public-" + UUID.randomUUID(), "PUBLIC"));
        JsonNode publicNode = json(publicGroup);
        CONTRACT.assertValid("Chat", publicNode);
        assertThat(publicNode.get("member_count").asInt()).isEqualTo(3);
        UUID publicChatId = UUID.fromString(publicNode.get("id").asText());

        // The list and the detail mapping return the same exact numbers.
        JsonNode list = chats(owner, workspaceId);
        CONTRACT.assertValid("ChatList", list);
        assertThat(chatNode(list, directChatId).get("member_count").asInt()).isEqualTo(2);
        assertThat(chatNode(list, privateChatId).get("member_count").asInt()).isEqualTo(2);
        assertThat(chatNode(list, publicChatId).get("member_count").asInt()).isEqualTo(3);
        // A private channel with 2 members must not echo the 3 workspace members.
        assertThat(chatNode(list, privateChatId).get("member_count").asInt())
                .isNotEqualTo(3);

        MvcResult detail = mockMvc.perform(authed(
                        patch("/api/v1/chats/{chatId}", publicChatId), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(
                                Map.of("name", "renamed-" + UUID.randomUUID()))))
                .andExpect(status().isOk())
                .andReturn();
        CONTRACT.assertValid("Chat", json(detail));
        assertThat(json(detail).get("member_count").asInt()).isEqualTo(3);

        // Leaving removes the participant row: PRIVATE drops to 1, PUBLIC to 2, DIRECT
        // stays 2 while both participants are still workspace members.
        leave(second, workspaceId).andExpect(status().isNoContent());
        JsonNode afterLeave = chats(owner, workspaceId);
        assertThat(chatNode(afterLeave, privateChatId).get("member_count").asInt()).isEqualTo(1);
        assertThat(chatNode(afterLeave, publicChatId).get("member_count").asInt()).isEqualTo(2);
        assertThat(chatNode(afterLeave, defaultChatId).get("member_count").asInt()).isEqualTo(2);
        assertThat(chatNode(afterLeave, directChatId).get("member_count").asInt()).isEqualTo(2);
    }

    @Test
    void lifecycleFunctionsRejectBypassAndStayPrivate() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("e99-rls-owner"));
        SessionResponse outsider = devSession(uniqueDisplayName("e99-rls-outsider"));
        UUID workspaceId = owner.workspace().id();

        String leaveOutcome = inTenant(outsider.user().id(), workspaceId, () ->
                (String) jdbc.queryForObject("""
                        SELECT outcome FROM workspace.leave_workspace(
                            CAST(? AS uuid), CAST(? AS uuid))
                        """, String.class, workspaceId, owner.user().id()));
        assertThat(leaveOutcome).isEqualTo("FORBIDDEN");

        // Spoofing the actor id is rejected even from the owner's tenant context.
        String spoofed = inTenant(owner.user().id(), workspaceId, () ->
                (String) jdbc.queryForObject("""
                        SELECT outcome FROM workspace.delete_workspace(
                            CAST(? AS uuid), CAST(? AS uuid))
                        """, String.class, workspaceId, outsider.user().id()));
        assertThat(spoofed).isEqualTo("FORBIDDEN");
        assertThat(workspaceStatus(workspaceId)).isEqualTo("ACTIVE");

        Long publicExecute = migrator().queryForObject("""
                SELECT count(*) FROM pg_proc p
                  JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'workspace'
                   AND p.proname IN ('leave_workspace', 'delete_workspace')
                   AND has_function_privilege('public', p.oid, 'EXECUTE')
                """, Long.class);
        assertThat(publicExecute).isZero();

        // The soft-delete columns exist and are part of the schema contract.
        Long columns = migrator().queryForObject("""
                SELECT count(*) FROM information_schema.columns
                 WHERE table_schema = 'workspace' AND table_name = 'workspaces'
                   AND column_name IN ('deleted_at', 'deleted_by')
                """, Long.class);
        assertThat(columns).isEqualTo(2);

        // RLS keeps a foreign workspace invisible in another tenant context.
        Long visible = inTenant(outsider.user().id(), outsider.workspace().id(), () ->
                jdbc.queryForObject("""
                        SELECT count(*) FROM workspace.workspaces WHERE id = ?
                        """, Long.class, workspaceId));
        assertThat(visible).isZero();
    }

    // ------------------------------------------------------------------

    private ResultActions addMember(SessionResponse actor, UUID workspaceId, String email,
                                    String role) throws Exception {
        return mockMvc.perform(authed(
                        post("/api/v1/workspaces/{workspaceId}/members", workspaceId), actor)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(Map.of(
                        "email", email, "role", role))));
    }

    private ResultActions leave(SessionResponse actor, UUID workspaceId) throws Exception {
        return mockMvc.perform(authed(delete(
                "/api/v1/workspaces/{workspaceId}/members/me", workspaceId), actor));
    }

    private ResultActions deleteWorkspace(SessionResponse actor, UUID workspaceId)
            throws Exception {
        return mockMvc.perform(authed(
                delete("/api/v1/workspaces/{workspaceId}", workspaceId), actor));
    }

    private JsonNode getMe(SessionResponse session) throws Exception {
        MvcResult result = mockMvc.perform(authed(get("/api/v1/me"), session))
                .andExpect(status().isOk())
                .andReturn();
        return json(result);
    }

    private JsonNode chats(SessionResponse session, UUID workspaceId) throws Exception {
        MvcResult result = mockMvc.perform(authed(
                        get("/api/v1/workspaces/{workspaceId}/chats", workspaceId), session))
                .andExpect(status().isOk())
                .andReturn();
        return json(result);
    }

    private JsonNode members(SessionResponse actor, UUID workspaceId) throws Exception {
        MvcResult result = mockMvc.perform(authed(
                        get("/api/v1/workspaces/{workspaceId}/members", workspaceId), actor))
                .andExpect(status().isOk())
                .andReturn();
        return json(result);
    }

    private MvcResult createChat(SessionResponse actor, UUID workspaceId, Map<String, Object> body)
            throws Exception {
        return mockMvc.perform(authed(
                        post("/api/v1/workspaces/{workspaceId}/chats", workspaceId), actor)
                        .header("Idempotency-Key", UUID.randomUUID().toString())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(body)))
                .andExpect(status().isCreated())
                .andReturn();
    }

    private static Map<String, Object> groupBody(String name, String visibility,
                                                 UUID... memberIds) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("type", "GROUP");
        body.put("name", name);
        body.put("visibility", visibility);
        if (memberIds.length > 0) {
            body.put("member_ids", java.util.Arrays.stream(memberIds)
                    .map(UUID::toString).toList());
        }
        return body;
    }

    private int chatMemberCount(SessionResponse viewer, UUID workspaceId, UUID chatId)
            throws Exception {
        return chatNode(chats(viewer, workspaceId), chatId).get("member_count").asInt();
    }

    private static JsonNode chatNode(JsonNode list, UUID chatId) {
        for (JsonNode item : list.get("items")) {
            if (item.get("id").asText().equals(chatId.toString())) {
                return item;
            }
        }
        throw new AssertionError("chat not found in list: " + chatId);
    }

    private UUID createBot(SessionResponse actor, UUID workspaceId) throws Exception {
        MvcResult result = mockMvc.perform(authed(
                        post("/api/v1/workspaces/{workspaceId}/bots", workspaceId), actor)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "name", "e99-" + UUID.randomUUID(),
                                "scopes", java.util.List.of("chat.write")))))
                .andExpect(status().isCreated())
                .andReturn();
        return UUID.fromString(json(result).at("/bot/id").asText());
    }

    private String botToken(SessionResponse actor, UUID workspaceId, UUID botId)
            throws Exception {
        // The create response is the only place the raw token appears; re-read it from the
        // one-time create above is not possible, so rotate explicitly for the test.
        MvcResult result = mockMvc.perform(authed(
                        post("/api/v1/workspaces/{workspaceId}/bots/{botId}/token",
                                workspaceId, botId), actor))
                .andExpect(status().isOk())
                .andReturn();
        return json(result).get("token").asText();
    }

    private ResultActions installBot(SessionResponse actor, UUID chatId, UUID botId)
            throws Exception {
        return mockMvc.perform(authed(post("/api/v1/chats/{chatId}/bots", chatId), actor)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(Map.of(
                        "bot_id", botId.toString()))));
    }

    private String createInviteToken(SessionResponse actor, UUID workspaceId) throws Exception {
        MvcResult result = mockMvc.perform(authed(
                        post("/api/v1/workspaces/{workspaceId}/invites", workspaceId), actor)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{}"))
                .andExpect(status().isCreated())
                .andReturn();
        return json(result).get("token").asText();
    }

    private String emailOf(UUID userId) {
        return migrator().queryForObject(
                "SELECT email::text FROM auth.users WHERE id = ?", String.class, userId);
    }

    private Map<String, Object> membership(UUID workspaceId, UUID userId) {
        return migrator().queryForMap("""
                SELECT role, status, joined_at FROM workspace.memberships
                 WHERE workspace_id = ? AND user_id = ?
                """, workspaceId, userId);
    }

    private java.util.List<String> chatParticipantStatus(UUID workspaceId, UUID userId) {
        return migrator().queryForList("""
                SELECT cm.status
                  FROM chat.chat_members cm
                  JOIN chat.chats c ON c.id = cm.chat_id
                 WHERE c.workspace_id = ? AND cm.user_id = ?
                """, String.class, workspaceId, userId);
    }

    private java.util.List<String> chatParticipantStatuses(UUID workspaceId) {
        return migrator().queryForList("""
                SELECT cm.status
                  FROM chat.chat_members cm
                  JOIN chat.chats c ON c.id = cm.chat_id
                 WHERE c.workspace_id = ?
                """, String.class, workspaceId);
    }

    private java.util.List<String> membershipStatuses(UUID workspaceId) {
        return migrator().queryForList("""
                SELECT status FROM workspace.memberships WHERE workspace_id = ?
                """, String.class, workspaceId);
    }

    private String workspaceStatus(UUID workspaceId) {
        return migrator().queryForObject(
                "SELECT status FROM workspace.workspaces WHERE id = ?", String.class,
                workspaceId);
    }

    private Object inviteRevokedAt(UUID workspaceId) {
        return migrator().queryForObject("""
                SELECT revoked_at FROM workspace.invites WHERE workspace_id = ?
                """, Object.class, workspaceId);
    }

    private String botStatus(UUID workspaceId) {
        return migrator().queryForObject("""
                SELECT status FROM bot.bots WHERE workspace_id = ?
                """, String.class, workspaceId);
    }

    private Object chatDeletedAt(UUID chatId) {
        return migrator().queryForObject(
                "SELECT deleted_at FROM chat.chats WHERE id = ?", Object.class, chatId);
    }

    private Map<String, Object> auditEvent(String action, UUID targetId) {
        return migrator().queryForMap("""
                SELECT actor_id, target_type, target_id, metadata::text AS metadata
                  FROM audit.audit_events
                 WHERE action = ? AND target_id = ?
                 ORDER BY created_at DESC, id DESC
                 LIMIT 1
                """, action, targetId);
    }

    private long auditCount(String action, UUID targetId) {
        Long count = migrator().queryForObject("""
                SELECT count(*) FROM audit.audit_events WHERE action = ? AND target_id = ?
                """, Long.class, action, targetId);
        return count == null ? 0 : count;
    }

    private static java.util.List<String> workspaceIds(JsonNode me) {
        java.util.List<String> ids = new java.util.ArrayList<>();
        me.get("workspaces").forEach(item -> ids.add(item.get("id").asText()));
        return ids;
    }

    private static java.util.List<UUID> userIds(JsonNode page) {
        java.util.List<UUID> ids = new java.util.ArrayList<>();
        page.get("items").forEach(item ->
                ids.add(UUID.fromString(item.get("user_id").asText())));
        return ids;
    }

    private void assertForbidden(ResultActions actions) throws Exception {
        MvcResult result = actions.andExpect(status().isForbidden()).andReturn();
        CONTRACT.assertValid("Error", json(result));
        assertThat(json(result).get("code").asText()).isEqualTo("FORBIDDEN");
    }

    private void assertForbiddenCode(ResultActions actions, String code) throws Exception {
        MvcResult result = actions.andExpect(status().isForbidden()).andReturn();
        CONTRACT.assertValid("Error", json(result));
        assertThat(json(result).get("code").asText()).isEqualTo(code);
    }
}
