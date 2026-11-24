package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.support.IntegrationTestBase;
import ru.krug.backend.support.OpenApiContract;

/**
 * E10-B end-to-end: the active workspace member directory and its use for DIRECT-chat
 * creation. Covers active-only filtering, literal search, stable keyset pagination,
 * membership authorization (non-member/foreign workspace), cursor validation, the
 * database-level RLS guard, absence of email/credential leakage, and DIRECT idempotency.
 */
@ActiveProfiles("test")
class WorkspaceMemberDirectoryIT extends IntegrationTestBase {

    private static final OpenApiContract CONTRACT = OpenApiContract.load();

    @Test
    void listsOnlyActiveMembersWithContractFieldsAndNoEmailLeak() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("e10b-owner"));
        String prefix = "e10b-active-" + shortId() + "-";
        SessionResponse first = createMember(owner, prefix + "a");
        SessionResponse second = createMember(owner, prefix + "b");

        SessionResponse removed = createMember(owner, prefix + "removed");
        membership(owner.workspace().id(), removed.user().id(), "MEMBER", "REMOVED");
        SessionResponse invited = createMember(owner, prefix + "invited");
        membership(owner.workspace().id(), invited.user().id(), "MEMBER", "INVITED");
        SessionResponse suspended = createMember(owner, prefix + "suspended");
        setUserStatus(suspended.user().id(), "SUSPENDED");
        SessionResponse deleted = createMember(owner, prefix + "deleted");
        setUserStatus(deleted.user().id(), "DELETED");

        String firstEmail = "secret-" + UUID.randomUUID() + "@example.test";
        String secondEmail = "secret-" + UUID.randomUUID() + "@example.test";
        setEmail(first.user().id(), firstEmail);
        setEmail(second.user().id(), secondEmail);

        MvcResult result = mockMvc.perform(authed(
                        get("/api/v1/workspaces/{workspaceId}/members",
                                owner.workspace().id()), owner)
                        .param("query", prefix)
                        .param("limit", "100"))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode page = json(result);
        CONTRACT.assertValid("WorkspaceMemberPage", page);
        assertThat(page.get("has_more").asBoolean()).isFalse();
        assertThat(page.get("next_cursor").isNull()).isTrue();
        assertThat(userIds(page)).containsExactlyInAnyOrder(first.user().id(),
                second.user().id());

        for (JsonNode item : page.get("items")) {
            Set<String> fields = new LinkedHashSet<>();
            item.fieldNames().forEachRemaining(fields::add);
            assertThat(fields).containsExactlyInAnyOrder("user_id", "display_name", "role",
                    "joined_at");
            assertThat(item.get("joined_at").isNull()).isFalse();
            assertThat(item.get("role").asText()).isEqualTo("MEMBER");
        }

        String body = result.getResponse().getContentAsString();
        assertThat(body).doesNotContain(firstEmail).doesNotContain(secondEmail)
                .doesNotContain("\"email\"").doesNotContain("password");
    }

    @Test
    void includesCallerAndReportsMembershipRoleAndJoinedAt() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("e10b-caller"));
        String prefix = "e10b-caller-" + shortId() + "-";
        SessionResponse admin = createMember(owner, prefix + "admin");
        membership(owner.workspace().id(), admin.user().id(), "ADMIN", "ACTIVE");

        JsonNode page = membersPage(owner, owner.workspace().id(), null, null, 100);
        assertThat(userIds(page)).containsExactlyInAnyOrder(owner.user().id(),
                admin.user().id());
        assertThat(item(page, owner.user().id()).get("role").asText()).isEqualTo("OWNER");
        assertThat(item(page, admin.user().id()).get("role").asText()).isEqualTo("ADMIN");
        assertThat(item(page, admin.user().id()).get("display_name").asText()).startsWith(prefix);
        assertThat(item(page, admin.user().id()).get("joined_at").isNull()).isFalse();
    }

    @Test
    void searchIsLiteralCaseInsensitiveAndPaginationIsStable() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("e10b-page"));
        String prefix = "e10b-pg-" + shortId() + "-";
        List<String> names = new ArrayList<>();
        List<UUID> ids = new ArrayList<>();
        for (int i = 0; i < 5; i++) {
            String name = prefix + i;
            SessionResponse member = createMember(owner, name);
            names.add(name);
            ids.add(member.user().id());
        }

        JsonNode first = membersPage(owner, owner.workspace().id(), prefix, null, 2);
        assertThat(first.get("items")).hasSize(2);
        assertThat(first.get("has_more").asBoolean()).isTrue();
        assertThat(first.get("next_cursor").isNull()).isFalse();

        JsonNode second = membersPage(owner, owner.workspace().id(), prefix,
                first.get("next_cursor").asText(), 2);
        assertThat(second.get("items")).hasSize(2);
        assertThat(second.get("has_more").asBoolean()).isTrue();

        JsonNode third = membersPage(owner, owner.workspace().id(), prefix,
                second.get("next_cursor").asText(), 2);
        assertThat(third.get("items")).hasSize(1);
        assertThat(third.get("has_more").asBoolean()).isFalse();
        assertThat(third.get("next_cursor").isNull()).isTrue();

        List<UUID> paged = new ArrayList<>(userIds(first));
        paged.addAll(userIds(second));
        paged.addAll(userIds(third));
        assertThat(paged).containsExactlyElementsOf(ids);

        List<String> pagedNames = new ArrayList<>(displayNames(first));
        pagedNames.addAll(displayNames(second));
        pagedNames.addAll(displayNames(third));
        List<String> sorted = new ArrayList<>(pagedNames);
        sorted.sort(String::compareTo);
        assertThat(pagedNames).containsExactlyElementsOf(sorted);

        // Case-insensitive search over the same literal prefix.
        JsonNode upper = membersPage(owner, owner.workspace().id(),
                prefix.toUpperCase(Locale.ROOT), null, 100);
        assertThat(userIds(upper)).containsExactlyInAnyOrderElementsOf(ids);

        // '%' is a literal character: a LIKE implementation would return every member.
        SessionResponse percent = createMember(owner, "e10b-lit-" + shortId() + "-%");
        SessionResponse plain = createMember(owner, "e10b-lit-" + shortId() + "-x");
        JsonNode literal = membersPage(owner, owner.workspace().id(), "%", null, 100);
        assertThat(userIds(literal)).containsExactly(percent.user().id());
        assertThat(userIds(literal)).doesNotContain(plain.user().id());
    }

    @Test
    void nonMemberForeignAndUnknownWorkspacesAreForbidden() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("e10b-auth"));
        SessionResponse member = createMember(owner, "e10b-auth-" + shortId() + "-member");
        SessionResponse outsider = devSession(uniqueDisplayName("e10b-outsider"));

        assertForbidden(authed(get("/api/v1/workspaces/{workspaceId}/members",
                owner.workspace().id()), outsider));
        assertForbidden(authed(get("/api/v1/workspaces/{workspaceId}/members",
                outsider.workspace().id()), owner));
        assertForbidden(authed(get("/api/v1/workspaces/{workspaceId}/members",
                UUID.randomUUID()), owner));

        // Any ACTIVE member, not only OWNER/ADMIN, can read the directory.
        JsonNode page = membersPage(member, owner.workspace().id(), null, null, 100);
        assertThat(userIds(page)).contains(owner.user().id(), member.user().id());

        MvcResult unauthorized = mockMvc.perform(
                        get("/api/v1/workspaces/{workspaceId}/members",
                                owner.workspace().id()))
                .andExpect(status().isUnauthorized())
                .andReturn();
        assertThat(json(unauthorized).get("code").asText()).isEqualTo("UNAUTHENTICATED");
    }

    @Test
    void invalidLimitQueryAndCursorsAreRejected() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("e10b-invalid"));
        createMember(owner, "e10b-invalid-" + shortId() + "-member");

        assertValidationFailed(authed(get("/api/v1/workspaces/{workspaceId}/members",
                owner.workspace().id()), owner).param("limit", "0"));
        assertValidationFailed(authed(get("/api/v1/workspaces/{workspaceId}/members",
                owner.workspace().id()), owner).param("limit", "101"));
        assertValidationFailed(authed(get("/api/v1/workspaces/{workspaceId}/members",
                owner.workspace().id()), owner).param("limit", "abc"));
        assertValidationFailed(authed(get("/api/v1/workspaces/{workspaceId}/members",
                owner.workspace().id()), owner).param("query", "x".repeat(81)));
        assertValidationFailed(authed(get("/api/v1/workspaces/{workspaceId}/members",
                owner.workspace().id()), owner).param("cursor", "garbage"));

        // A cursor is bound to one workspace, even when the caller belongs to both.
        SessionResponse other = devSession(uniqueDisplayName("e10b-other"));
        membership(other.workspace().id(), owner.user().id(), "MEMBER", "ACTIVE");
        createMember(other, "e10b-other-" + shortId() + "-member");
        JsonNode otherPage = membersPage(other, other.workspace().id(), null, null, 1);
        assertThat(otherPage.get("has_more").asBoolean()).isTrue();
        assertValidationFailed(authed(get("/api/v1/workspaces/{workspaceId}/members",
                owner.workspace().id()), owner)
                .param("cursor", otherPage.get("next_cursor").asText()));
    }

    @Test
    void memberDirectoryFunctionIsCallerScopedEvenWithoutTheHttpGuard() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("e10b-rls"));
        SessionResponse member = createMember(owner, "e10b-rls-" + shortId() + "-member");
        SessionResponse outsider = devSession(uniqueDisplayName("e10b-rls-outsider"));

        Long memberRows = inTenant(member.user().id(), owner.workspace().id(), () ->
                jdbc.queryForObject("""
                        SELECT count(*)
                          FROM workspace.member_directory(CAST(? AS uuid),
                                                          CAST(NULL AS text),
                                                          CAST(100 AS integer),
                                                          CAST(NULL AS text),
                                                          CAST(NULL AS uuid))
                        """, Long.class, owner.workspace().id()));
        assertThat(memberRows).isEqualTo(2L);

        Long outsiderRows = inTenant(outsider.user().id(), owner.workspace().id(), () ->
                jdbc.queryForObject("""
                        SELECT count(*)
                          FROM workspace.member_directory(CAST(? AS uuid),
                                                          CAST(NULL AS text),
                                                          CAST(100 AS integer),
                                                          CAST(NULL AS text),
                                                          CAST(NULL AS uuid))
                        """, Long.class, owner.workspace().id()));
        assertThat(outsiderRows).isZero();
    }

    @Test
    void directChatCreationUsesDirectoryAndRemainsIdempotent() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("e10b-direct"));
        String peerName = "e10b-direct-peer-" + shortId();
        SessionResponse peer = createMember(owner, peerName);

        JsonNode directory = membersPage(owner, owner.workspace().id(), peerName, null, 100);
        assertThat(userIds(directory)).containsExactly(peer.user().id());
        assertThat(directory.at("/items/0/display_name").asText()).isEqualTo(peerName);
        assertThat(directory.at("/items/0/role").asText()).isEqualTo("MEMBER");

        MvcResult created = mockMvc.perform(authed(
                        post("/api/v1/workspaces/{workspaceId}/chats",
                                owner.workspace().id()), owner)
                        .header("Idempotency-Key", UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(directBody(peer.user().id())))
                .andExpect(status().isCreated())
                .andReturn();
        JsonNode chat = json(created);
        CONTRACT.assertValid("Chat", chat);
        UUID chatId = UUID.fromString(chat.get("id").asText());
        assertThat(chat.get("type").asText()).isEqualTo("DIRECT");
        assertThat(chat.get("peer_id").asText()).isEqualTo(peer.user().id().toString());

        MvcResult repeated = mockMvc.perform(authed(
                        post("/api/v1/workspaces/{workspaceId}/chats",
                                owner.workspace().id()), owner)
                        .header("Idempotency-Key", UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(directBody(peer.user().id())))
                .andExpect(status().isOk())
                .andReturn();
        assertThat(json(repeated).get("id").asText()).isEqualTo(chatId.toString());

        // The peer finds the owner in the same directory and gets the same pair.
        JsonNode peerDirectory = membersPage(peer, owner.workspace().id(),
                owner.user().displayName(), null, 100);
        assertThat(userIds(peerDirectory)).contains(owner.user().id());
        MvcResult reverse = mockMvc.perform(authed(
                        post("/api/v1/workspaces/{workspaceId}/chats",
                                owner.workspace().id()), peer)
                        .header("Idempotency-Key", UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(directBody(owner.user().id())))
                .andExpect(status().isOk())
                .andReturn();
        assertThat(json(reverse).get("id").asText()).isEqualTo(chatId.toString());

        Long directChats = migrator().queryForObject("""
                SELECT count(*) FROM chat.chats
                 WHERE workspace_id = ? AND type = 'DIRECT' AND deleted_at IS NULL
                """, Long.class, owner.workspace().id());
        assertThat(directChats).isEqualTo(1L);

        SessionResponse removedPeer = createMember(owner,
                "e10b-direct-removed-" + shortId());
        membership(owner.workspace().id(), removedPeer.user().id(), "MEMBER", "REMOVED");
        assertDirectRejected(owner, removedPeer.user().id(), "VALIDATION_FAILED");
        SessionResponse foreignPeer = devSession(uniqueDisplayName("e10b-direct-foreign"));
        assertDirectRejected(owner, foreignPeer.user().id(), "VALIDATION_FAILED");
    }

    // ---------------------------------------------------------------------

    private JsonNode membersPage(SessionResponse session, UUID workspaceId, String query,
                                 String cursor, Integer limit) throws Exception {
        MockHttpServletRequestBuilder request = authed(
                get("/api/v1/workspaces/{workspaceId}/members", workspaceId), session);
        if (query != null) {
            request.param("query", query);
        }
        if (cursor != null) {
            request.param("cursor", cursor);
        }
        if (limit != null) {
            request.param("limit", limit.toString());
        }
        MvcResult result = mockMvc.perform(request).andExpect(status().isOk()).andReturn();
        JsonNode page = json(result);
        CONTRACT.assertValid("WorkspaceMemberPage", page);
        return page;
    }

    private SessionResponse createMember(SessionResponse workspaceOwner, String displayName)
            throws Exception {
        SessionResponse member = devSession(displayName);
        membership(workspaceOwner.workspace().id(), member.user().id(), "MEMBER", "ACTIVE");
        return member;
    }

    private void membership(UUID workspaceId, UUID userId, String role, String status) {
        migrator().update("""
                INSERT INTO workspace.memberships (workspace_id, user_id, role, status)
                VALUES (?, ?, ?, ?)
                ON CONFLICT (workspace_id, user_id) DO UPDATE
                   SET role = EXCLUDED.role,
                       status = EXCLUDED.status,
                       updated_at = now()
                """, workspaceId, userId, role, status);
    }

    private void setUserStatus(UUID userId, String status) {
        migrator().update("UPDATE auth.users SET status = ? WHERE id = ?", status, userId);
    }

    private void setEmail(UUID userId, String email) {
        migrator().update("UPDATE auth.users SET email = ? WHERE id = ?", email, userId);
    }

    private String directBody(UUID peerId) throws Exception {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("type", "DIRECT");
        body.put("peer_id", peerId.toString());
        return objectMapper.writeValueAsString(body);
    }

    private void assertDirectRejected(SessionResponse actor, UUID peerId, String code)
            throws Exception {
        MvcResult result = mockMvc.perform(authed(
                        post("/api/v1/workspaces/{workspaceId}/chats",
                                actor.workspace().id()), actor)
                        .header("Idempotency-Key", UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(directBody(peerId)))
                .andExpect(status().isBadRequest())
                .andReturn();
        JsonNode error = json(result);
        assertThat(error.get("code").asText()).isEqualTo(code);
        assertThat(error.at("/details/field").asText()).isEqualTo("peer_id");
    }

    private void assertForbidden(MockHttpServletRequestBuilder request) throws Exception {
        MvcResult result = mockMvc.perform(request)
                .andExpect(status().isForbidden())
                .andReturn();
        assertThat(json(result).get("code").asText()).isEqualTo("FORBIDDEN");
    }

    private void assertValidationFailed(MockHttpServletRequestBuilder request) throws Exception {
        MvcResult result = mockMvc.perform(request)
                .andExpect(status().isBadRequest())
                .andReturn();
        assertThat(json(result).get("code").asText()).isEqualTo("VALIDATION_FAILED");
    }

    private static List<UUID> userIds(JsonNode page) {
        List<UUID> ids = new ArrayList<>();
        page.get("items").forEach(item ->
                ids.add(UUID.fromString(item.get("user_id").asText())));
        return ids;
    }

    private static List<String> displayNames(JsonNode page) {
        List<String> names = new ArrayList<>();
        page.get("items").forEach(item -> names.add(item.get("display_name").asText()));
        return names;
    }

    private static JsonNode item(JsonNode page, UUID userId) {
        for (JsonNode item : page.get("items")) {
            if (userId.toString().equals(item.get("user_id").asText())) {
                return item;
            }
        }
        throw new AssertionError("member not found: " + userId);
    }

    private static String shortId() {
        return UUID.randomUUID().toString().substring(0, 8);
    }
}
