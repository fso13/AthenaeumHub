package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.support.IntegrationTestBase;
import ru.krug.backend.support.OpenApiContract;

/**
 * E12-B end-to-end: workspace member management (R-09, FR-WS-4…FR-WS-7).
 *
 * <p>Covers add by email, role changes, soft removal, the atomic
 * {@code max_workspace_members} limit, duplicates/unknown emails, non-admin 403, owner/self
 * protections, audit metadata without email and the database-level RLS/guard backstops.</p>
 */
@ActiveProfiles("test")
class WorkspaceMemberManagementIT extends IntegrationTestBase {

    private static final OpenApiContract CONTRACT = OpenApiContract.load();
    private static final int DEFAULT_MAX_MEMBERS = 100;

    @AfterEach
    void restoreMemberLimit() {
        migrator().update("UPDATE ops.system_settings SET max_workspace_members = ? WHERE id = 1",
                DEFAULT_MAX_MEMBERS);
    }

    @Test
    void ownerAddsExistingUserByEmailAndAuditHasNoEmail() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("e12-add-owner"));
        SessionResponse target = devSession(uniqueDisplayName("e12-add-target"));
        String email = emailOf(target.user().id());

        assertForbidden(mockMvc.perform(authed(
                get("/api/v1/workspaces/{workspaceId}/members",
                        owner.workspace().id()), target)));

        MvcResult added = add(owner, owner.workspace().id(), email, "MEMBER")
                .andExpect(status().isCreated())
                .andReturn();
        JsonNode member = json(added);
        CONTRACT.assertValid("WorkspaceMember", member);
        assertThat(member.get("user_id").asText()).isEqualTo(target.user().id().toString());
        assertThat(member.get("display_name").asText()).isEqualTo(target.user().displayName());
        assertThat(member.get("role").asText()).isEqualTo("MEMBER");
        assertThat(member.get("joined_at").isNull()).isFalse();
        assertThat(added.getResponse().getContentAsString())
                .doesNotContain(email).doesNotContain("\"email\"");

        // The member sees the workspace and its chats on the next request.
        JsonNode page = members(owner, owner.workspace().id());
        assertThat(userIds(page)).contains(owner.user().id(), target.user().id());
        mockMvc.perform(authed(get("/api/v1/workspaces/{workspaceId}/chats",
                        owner.workspace().id()), target))
                .andExpect(status().isOk());

        Map<String, Object> membership = migrator().queryForMap("""
                SELECT role, status, joined_at FROM workspace.memberships
                 WHERE workspace_id = ? AND user_id = ?
                """, owner.workspace().id(), target.user().id());
        assertThat(membership.get("role")).isEqualTo("MEMBER");
        assertThat(membership.get("status")).isEqualTo("ACTIVE");
        assertThat(membership.get("joined_at")).isNotNull();

        Map<String, Object> event = auditEvent("workspace.member.added",
                target.user().id());
        assertThat(event.get("actor_id")).isEqualTo(owner.user().id());
        assertThat(event.get("target_type")).isEqualTo("user");
        assertThat(String.valueOf(event.get("metadata")))
                .contains("MEMBER").doesNotContain(email)
                .doesNotContain(target.user().displayName());

        // Duplicate (including a previously removed row) and unknown emails are explicit.
        MvcResult duplicate = add(owner, owner.workspace().id(), email, "MEMBER")
                .andExpect(status().isConflict())
                .andReturn();
        CONTRACT.assertValid("Error", json(duplicate));
        assertThat(json(duplicate).get("code").asText()).isEqualTo("MEMBER_ALREADY_EXISTS");

        MvcResult unknown = add(owner, owner.workspace().id(),
                "missing-" + UUID.randomUUID() + "@example.test", "MEMBER")
                .andExpect(status().isNotFound())
                .andReturn();
        CONTRACT.assertValid("Error", json(unknown));
        assertThat(json(unknown).get("code").asText()).isEqualTo("USER_NOT_FOUND");
    }

    @Test
    void memberLimitIsEnforcedAtomically() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("e12-limit-owner"));
        SessionResponse first = devSession(uniqueDisplayName("e12-limit-first"));
        setMemberLimit(2);

        add(owner, owner.workspace().id(), emailOf(first.user().id()), "MEMBER")
                .andExpect(status().isCreated());

        SessionResponse second = devSession(uniqueDisplayName("e12-limit-second"));
        MvcResult exceeded = add(owner, owner.workspace().id(), emailOf(second.user().id()),
                "MEMBER")
                .andExpect(status().isConflict())
                .andReturn();
        JsonNode error = json(exceeded);
        CONTRACT.assertValid("Error", error);
        assertThat(error.get("code").asText()).isEqualTo("WORKSPACE_MEMBER_LIMIT_REACHED");
        assertThat(error.at("/details/scope").asText()).isEqualTo("WORKSPACE");
        assertThat(error.at("/details/limit").asInt()).isEqualTo(2);
        assertThat(error.at("/details/used").asInt()).isEqualTo(2);

        // Two concurrent adds for the last slot: the per-workspace advisory lock makes the
        // count+insert atomic, so exactly one wins and one gets the limit conflict.
        SessionResponse concurrentOwner = devSession(uniqueDisplayName("e12-race-owner"));
        SessionResponse left = devSession(uniqueDisplayName("e12-race-left"));
        SessionResponse right = devSession(uniqueDisplayName("e12-race-right"));
        setMemberLimit(2);
        List<Integer> statuses = raceAdds(concurrentOwner, left, right);
        assertThat(statuses).containsExactlyInAnyOrder(201, 409);
        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM workspace.memberships
                 WHERE workspace_id = ? AND status = 'ACTIVE'
                """, Long.class, concurrentOwner.workspace().id())).isEqualTo(2L);
    }

    @Test
    void roleChangesRespectOwnerAndAdminRules() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("e12-role-owner"));
        SessionResponse admin = devSession(uniqueDisplayName("e12-role-admin"));
        SessionResponse member = devSession(uniqueDisplayName("e12-role-member"));
        SessionResponse guest = devSession(uniqueDisplayName("e12-role-guest"));

        add(owner, owner.workspace().id(), emailOf(admin.user().id()), "ADMIN")
                .andExpect(status().isCreated());
        add(owner, owner.workspace().id(), emailOf(member.user().id()), "MEMBER")
                .andExpect(status().isCreated());
        add(owner, owner.workspace().id(), emailOf(guest.user().id()), "GUEST")
                .andExpect(status().isCreated());

        // OWNER promotes MEMBER -> ADMIN and demotes ADMIN -> MEMBER.
        MvcResult promoted = changeRole(owner, owner.workspace().id(), member.user().id(),
                "ADMIN").andExpect(status().isOk()).andReturn();
        CONTRACT.assertValid("WorkspaceMember", json(promoted));
        assertThat(json(promoted).get("role").asText()).isEqualTo("ADMIN");
        Map<String, Object> event = auditEvent("workspace.member.role_changed",
                member.user().id());
        assertThat(String.valueOf(event.get("metadata")))
                .contains("previous_role").contains("MEMBER").contains("ADMIN");

        changeRole(owner, owner.workspace().id(), admin.user().id(), "MEMBER")
                .andExpect(status().isOk());

        // Newly promoted ADMIN can manage MEMBER/GUEST only.
        changeRole(member, owner.workspace().id(), guest.user().id(), "MEMBER")
                .andExpect(status().isOk());
        changeRole(member, owner.workspace().id(), guest.user().id(), "GUEST")
                .andExpect(status().isOk());
        assertForbiddenCode(changeRole(member, owner.workspace().id(), owner.user().id(),
                "MEMBER"), "ROLE_CHANGE_FORBIDDEN");
        assertConflict(changeRole(member, owner.workspace().id(), member.user().id(),
                "GUEST"), "SELF_ACTION_FORBIDDEN");
        SessionResponse another = devSession(uniqueDisplayName("e12-role-another"));
        add(owner, owner.workspace().id(), emailOf(another.user().id()), "MEMBER")
                .andExpect(status().isCreated());
        assertForbiddenCode(changeRole(member, owner.workspace().id(), another.user().id(),
                "ADMIN"), "ROLE_CHANGE_FORBIDDEN");

        // OWNER is immutable/never assignable; the last owner cannot be demoted.
        assertForbiddenCode(changeRole(owner, owner.workspace().id(), guest.user().id(),
                "OWNER"), "ROLE_CHANGE_FORBIDDEN");
        assertConflict(changeRole(owner, owner.workspace().id(), owner.user().id(), "MEMBER"),
                "LAST_OWNER");

        // No-op is idempotent and adds no audit noise.
        long before = auditCount("workspace.member.role_changed", guest.user().id());
        changeRole(owner, owner.workspace().id(), guest.user().id(), "GUEST")
                .andExpect(status().isOk());
        assertThat(auditCount("workspace.member.role_changed", guest.user().id()))
                .isEqualTo(before);

        MvcResult missing = changeRole(owner, owner.workspace().id(), UUID.randomUUID(),
                "MEMBER").andExpect(status().isNotFound()).andReturn();
        assertThat(json(missing).get("code").asText()).isEqualTo("MEMBER_NOT_FOUND");
    }

    @Test
    void nonAdminAndOutsiderAreForbidden() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("e12-auth-owner"));
        SessionResponse member = devSession(uniqueDisplayName("e12-auth-member"));
        SessionResponse target = devSession(uniqueDisplayName("e12-auth-target"));
        SessionResponse outsider = devSession(uniqueDisplayName("e12-auth-outsider"));

        add(owner, owner.workspace().id(), emailOf(member.user().id()), "MEMBER")
                .andExpect(status().isCreated());
        add(owner, owner.workspace().id(), emailOf(target.user().id()), "MEMBER")
                .andExpect(status().isCreated());

        assertForbidden(add(member, owner.workspace().id(),
                "unused-" + UUID.randomUUID() + "@example.test", "MEMBER"));
        assertForbidden(changeRole(member, owner.workspace().id(), target.user().id(),
                "MEMBER"));
        assertForbidden(remove(member, owner.workspace().id(), target.user().id()));
        assertForbidden(add(outsider, owner.workspace().id(),
                "unused-" + UUID.randomUUID() + "@example.test", "MEMBER"));
        assertForbidden(changeRole(outsider, owner.workspace().id(), target.user().id(),
                "MEMBER"));
        assertForbidden(remove(outsider, owner.workspace().id(), target.user().id()));
        assertForbidden(add(owner, UUID.randomUUID(),
                "unused-" + UUID.randomUUID() + "@example.test", "MEMBER"));

        // Denied operations changed nothing.
        assertThat(memberRole(owner.workspace().id(), target.user().id())).isEqualTo("MEMBER");
        mockMvc.perform(authed(get("/api/v1/workspaces/{workspaceId}/chats",
                        owner.workspace().id()), target))
                .andExpect(status().isOk());

        // A non-admin cannot even see/manage via API after the guard.
        mockMvc.perform(authed(get("/api/v1/workspaces/{workspaceId}/members",
                        owner.workspace().id()), outsider))
                .andExpect(status().isForbidden());
    }

    @Test
    void removalIsSoftAndTakesEffectOnTheNextRequest() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("e12-remove-owner"));
        SessionResponse member = devSession(uniqueDisplayName("e12-remove-member"));
        String email = emailOf(member.user().id());
        add(owner, owner.workspace().id(), email, "MEMBER").andExpect(status().isCreated());

        mockMvc.perform(authed(get("/api/v1/workspaces/{workspaceId}/members",
                        owner.workspace().id()), member))
                .andExpect(status().isOk());
        mockMvc.perform(authed(get("/api/v1/workspaces/{workspaceId}/chats",
                        owner.workspace().id()), member))
                .andExpect(status().isOk());

        MvcResult removed = remove(owner, owner.workspace().id(), member.user().id())
                .andExpect(status().isNoContent())
                .andReturn();
        assertThat(removed.getResponse().getContentAsString()).isEmpty();

        Map<String, Object> membership = migrator().queryForMap("""
                SELECT role, status FROM workspace.memberships
                 WHERE workspace_id = ? AND user_id = ?
                """, owner.workspace().id(), member.user().id());
        assertThat(membership.get("status")).isEqualTo("REMOVED");
        assertThat(membership.get("role")).isEqualTo("MEMBER");
        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM workspace.memberships
                 WHERE workspace_id = ? AND user_id = ? AND joined_at IS NOT NULL
                """, Long.class, owner.workspace().id(), member.user().id())).isEqualTo(1L);

        Map<String, Object> event = auditEvent("workspace.member.removed",
                member.user().id());
        assertThat(event.get("actor_id")).isEqualTo(owner.user().id());
        assertThat(String.valueOf(event.get("metadata")))
                .contains("MEMBER").doesNotContain(email);

        // Access is re-evaluated per request; the token itself stays valid.
        assertForbidden(mockMvc.perform(authed(
                get("/api/v1/workspaces/{workspaceId}/members",
                        owner.workspace().id()), member)));
        assertForbidden(mockMvc.perform(authed(
                get("/api/v1/workspaces/{workspaceId}/chats",
                        owner.workspace().id()), member)));
        mockMvc.perform(authed(get("/api/v1/me"), member))
                .andExpect(status().isOk());

        // Re-adding a removed user is an explicit duplicate, and a second removal is 404.
        MvcResult reAdd = add(owner, owner.workspace().id(), email, "MEMBER")
                .andExpect(status().isConflict()).andReturn();
        assertThat(json(reAdd).get("code").asText()).isEqualTo("MEMBER_ALREADY_EXISTS");
        MvcResult removeAgain = remove(owner, owner.workspace().id(), member.user().id())
                .andExpect(status().isNotFound()).andReturn();
        assertThat(json(removeAgain).get("code").asText()).isEqualTo("MEMBER_NOT_FOUND");
    }

    @Test
    void databaseFunctionsAndRlsRejectBypassWithoutLeaks() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("e12-rls-owner"));
        SessionResponse target = devSession(uniqueDisplayName("e12-rls-target"));
        SessionResponse outsider = devSession(uniqueDisplayName("e12-rls-outsider"));

        String memberOutcome = inTenant(outsider.user().id(), owner.workspace().id(), () ->
                (String) jdbc.queryForObject("""
                        SELECT outcome FROM workspace.add_member(
                            CAST(? AS uuid), CAST(? AS uuid), CAST(? AS text),
                            CAST(? AS text))
                        """, String.class, owner.workspace().id(), outsider.user().id(),
                        emailOf(target.user().id()), "MEMBER"));
        assertThat(memberOutcome).isEqualTo("FORBIDDEN");

        // The actor id passed to the function must match the transaction principal.
        String spoofed = inTenant(outsider.user().id(), owner.workspace().id(), () ->
                (String) jdbc.queryForObject("""
                        SELECT outcome FROM workspace.add_member(
                            CAST(? AS uuid), CAST(? AS uuid), CAST(? AS text),
                            CAST(? AS text))
                        """, String.class, owner.workspace().id(), owner.user().id(),
                        emailOf(target.user().id()), "MEMBER"));
        assertThat(spoofed).isEqualTo("FORBIDDEN");

        String unknown = inTenant(owner.user().id(), owner.workspace().id(), () ->
                (String) jdbc.queryForObject("""
                        SELECT outcome FROM workspace.add_member(
                            CAST(? AS uuid), CAST(? AS uuid), CAST(? AS text),
                            CAST(? AS text))
                        """, String.class, owner.workspace().id(), owner.user().id(),
                        "missing-" + UUID.randomUUID() + "@example.test", "MEMBER"));
        assertThat(unknown).isEqualTo("USER_NOT_FOUND");

        // RLS still hides memberships and other users from the runtime role.
        Long memberships = inTenant(outsider.user().id(), outsider.workspace().id(), () ->
                jdbc.queryForObject("""
                        SELECT count(*) FROM workspace.memberships WHERE workspace_id = ?
                        """, Long.class, owner.workspace().id()));
        assertThat(memberships).isZero();
        Long users = inTenant(outsider.user().id(), owner.workspace().id(), () ->
                jdbc.queryForObject("SELECT count(*) FROM auth.users WHERE id = ?",
                        Long.class, target.user().id()));
        assertThat(users).isZero();

        // README requires EXECUTE for krug_app only, never PUBLIC.
        Long publicExecute = migrator().queryForObject("""
                SELECT count(*) FROM pg_proc p
                 JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'workspace'
                   AND p.proname IN ('add_member', 'change_member_role', 'remove_member')
                   AND has_function_privilege('public', p.oid, 'EXECUTE')
                """, Long.class);
        assertThat(publicExecute).isZero();
    }

    // ------------------------------------------------------------------

    private org.springframework.test.web.servlet.ResultActions add(
            SessionResponse actor, UUID workspaceId, String email, String role)
            throws Exception {
        return mockMvc.perform(authed(
                        post("/api/v1/workspaces/{workspaceId}/members", workspaceId), actor)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(Map.of(
                        "email", email, "role", role))));
    }

    private org.springframework.test.web.servlet.ResultActions changeRole(
            SessionResponse actor, UUID workspaceId, UUID targetId, String role)
            throws Exception {
        return mockMvc.perform(authed(
                        patch("/api/v1/workspaces/{workspaceId}/members/{userId}",
                                workspaceId, targetId), actor)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(Map.of("role", role))));
    }

    private org.springframework.test.web.servlet.ResultActions remove(
            SessionResponse actor, UUID workspaceId, UUID targetId) throws Exception {
        return mockMvc.perform(authed(
                delete("/api/v1/workspaces/{workspaceId}/members/{userId}",
                        workspaceId, targetId), actor));
    }

    private List<Integer> raceAdds(SessionResponse owner, SessionResponse left,
                                   SessionResponse right) throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(2);
        CountDownLatch start = new CountDownLatch(1);
        try {
            List<Future<Integer>> futures = new ArrayList<>();
            for (SessionResponse target : List.of(left, right)) {
                String email = emailOf(target.user().id());
                futures.add(pool.submit(() -> {
                    start.await(10, TimeUnit.SECONDS);
                    return mockMvc.perform(authed(post(
                                            "/api/v1/workspaces/{workspaceId}/members",
                                            owner.workspace().id()), owner)
                                    .contentType(MediaType.APPLICATION_JSON)
                                    .content(objectMapper.writeValueAsString(Map.of(
                                            "email", email, "role", "MEMBER"))))
                            .andReturn().getResponse().getStatus();
                }));
            }
            start.countDown();
            List<Integer> statuses = new ArrayList<>();
            for (Future<Integer> future : futures) {
                statuses.add(future.get(30, TimeUnit.SECONDS));
            }
            return statuses;
        } finally {
            pool.shutdownNow();
        }
    }

    private JsonNode members(SessionResponse actor, UUID workspaceId) throws Exception {
        MvcResult result = mockMvc.perform(authed(
                        get("/api/v1/workspaces/{workspaceId}/members", workspaceId), actor))
                .andExpect(status().isOk())
                .andReturn();
        return json(result);
    }

    private String emailOf(UUID userId) {
        return migrator().queryForObject(
                "SELECT email::text FROM auth.users WHERE id = ?", String.class, userId);
    }

    private void setMemberLimit(int limit) {
        migrator().update("UPDATE ops.system_settings SET max_workspace_members = ? WHERE id = 1",
                limit);
    }

    private String memberRole(UUID workspaceId, UUID userId) {
        return migrator().queryForObject("""
                SELECT role FROM workspace.memberships
                 WHERE workspace_id = ? AND user_id = ?
                """, String.class, workspaceId, userId);
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

    private void assertForbidden(
            org.springframework.test.web.servlet.ResultActions actions) throws Exception {
        MvcResult result = actions.andExpect(status().isForbidden()).andReturn();
        CONTRACT.assertValid("Error", json(result));
        assertThat(json(result).get("code").asText()).isEqualTo("FORBIDDEN");
    }

    private void assertForbiddenCode(
            org.springframework.test.web.servlet.ResultActions actions, String code)
            throws Exception {
        MvcResult result = actions.andExpect(status().isForbidden()).andReturn();
        CONTRACT.assertValid("Error", json(result));
        assertThat(json(result).get("code").asText()).isEqualTo(code);
    }

    private void assertConflict(
            org.springframework.test.web.servlet.ResultActions actions, String code)
            throws Exception {
        MvcResult result = actions.andExpect(status().isConflict()).andReturn();
        CONTRACT.assertValid("Error", json(result));
        assertThat(json(result).get("code").asText()).isEqualTo(code);
    }

    private static List<UUID> userIds(JsonNode page) {
        List<UUID> ids = new ArrayList<>();
        page.get("items").forEach(item ->
                ids.add(UUID.fromString(item.get("user_id").asText())));
        return ids;
    }
}
