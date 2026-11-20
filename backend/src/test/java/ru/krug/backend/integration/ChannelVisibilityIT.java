package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

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
 * GROUP channel visibility: PUBLIC (all ACTIVE workspace members, future joins) and PRIVATE
 * (creator + selected ACTIVE members). Covers creation, member-list validation, non-admin
 * creation with installation limits, automatic public joins, visibility in list summaries,
 * audit minimisation and the V39 schema/RLS backstops.
 */
@ActiveProfiles("test")
class ChannelVisibilityIT extends IntegrationTestBase {

    private static final OpenApiContract CONTRACT = OpenApiContract.load();

    @AfterEach
    void restoreChatLimits() {
        migrator().update("""
                UPDATE ops.system_settings
                   SET max_chats_per_user = 100, max_chats_per_workspace = 1000
                 WHERE id = 1
                """);
    }

    @Test
    void publicGroupIsDefaultWorkspaceWideAndListed() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("vis-public-owner"));
        SessionResponse member = devSession(uniqueDisplayName("vis-public-member"));
        UUID workspaceId = owner.workspace().id();
        addMember(owner, workspaceId, emailOf(member.user().id()), "MEMBER")
                .andExpect(status().isCreated());

        MvcResult created = createChat(owner, workspaceId, group("public-default"))
                .andExpect(status().isCreated())
                .andReturn();
        JsonNode chat = json(created);
        CONTRACT.assertValid("Chat", chat);
        assertThat(chat.get("type").asText()).isEqualTo("GROUP");
        assertThat(chat.get("visibility").asText()).isEqualTo("PUBLIC");

        UUID chatId = UUID.fromString(chat.get("id").asText());
        assertThat(member(chatId, owner.user().id()).get("role")).isEqualTo("OWNER");
        assertThat(member(chatId, member.user().id()).get("role")).isEqualTo("MEMBER");
        assertThat(visibilityRow(chatId)).isEqualTo("PUBLIC");

        // An explicit PUBLIC with an empty member list is the same request.
        MvcResult explicit = createChat(owner, workspaceId,
                group("public-explicit", "PUBLIC", List.of()))
                .andExpect(status().isCreated())
                .andReturn();
        assertThat(json(explicit).get("visibility").asText()).isEqualTo("PUBLIC");

        // The member sees the channel and its visibility; membership is still the gate.
        JsonNode listed = chatInList(member, workspaceId, chatId);
        CONTRACT.assertValid("ChatSummary", listed);
        assertThat(listed.get("visibility").asText()).isEqualTo("PUBLIC");

        Map<String, Object> event = auditEvent(chatId);
        assertThat(event.get("actor_id")).isEqualTo(owner.user().id());
        JsonNode metadata = objectMapper.readTree(String.valueOf(event.get("metadata")));
        assertThat(metadata.get("visibility").asText()).isEqualTo("PUBLIC");
        assertThat(metadata.get("member_count").asInt()).isEqualTo(2);
        assertThat(metadata.fieldNames()).toIterable()
                .containsExactlyInAnyOrder("visibility", "member_count");
    }

    @Test
    void privateGroupContainsOnlyCreatorAndSelectedMembers() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("vis-private-owner"));
        SessionResponse selected = devSession(uniqueDisplayName("vis-private-selected"));
        SessionResponse outsider = devSession(uniqueDisplayName("vis-private-outsider"));
        UUID workspaceId = owner.workspace().id();
        addMember(owner, workspaceId, emailOf(selected.user().id()), "MEMBER")
                .andExpect(status().isCreated());

        MvcResult created = createChat(owner, workspaceId,
                group("private-only", "PRIVATE", List.of(selected.user().id())))
                .andExpect(status().isCreated())
                .andReturn();
        JsonNode chat = json(created);
        CONTRACT.assertValid("Chat", chat);
        assertThat(chat.get("visibility").asText()).isEqualTo("PRIVATE");

        UUID chatId = UUID.fromString(chat.get("id").asText());
        assertThat(visibilityRow(chatId)).isEqualTo("PRIVATE");
        assertThat(member(chatId, owner.user().id()).get("role")).isEqualTo("OWNER");
        assertThat(member(chatId, selected.user().id()).get("role")).isEqualTo("MEMBER");
        assertThat(memberRow(chatId, outsider.user().id())).isNull();

        assertThat(chatInList(selected, workspaceId, chatId).get("visibility").asText())
                .isEqualTo("PRIVATE");

        Map<String, Object> event = auditEvent(chatId);
        JsonNode metadata = objectMapper.readTree(String.valueOf(event.get("metadata")));
        assertThat(metadata.get("visibility").asText()).isEqualTo("PRIVATE");
        assertThat(metadata.get("member_count").asInt()).isEqualTo(2);
        assertThat(metadata.fieldNames()).toIterable()
                .containsExactlyInAnyOrder("visibility", "member_count");
        assertThat(String.valueOf(event.get("metadata")))
                .doesNotContain(selected.user().id().toString())
                .doesNotContain(owner.user().id().toString());
    }

    @Test
    void rejectsInvalidPrivateMemberListsAndGroupOnlyFields() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("vis-invalid-owner"));
        SessionResponse active = devSession(uniqueDisplayName("vis-invalid-active"));
        SessionResponse outsider = devSession(uniqueDisplayName("vis-invalid-outsider"));
        UUID workspaceId = owner.workspace().id();
        addMember(owner, workspaceId, emailOf(active.user().id()), "MEMBER")
                .andExpect(status().isCreated());

        assertInvalid(owner, workspaceId, group("private-empty", "PRIVATE", List.of()),
                "member_ids");
        assertInvalid(owner, workspaceId,
                group("private-self", "PRIVATE", List.of(owner.user().id())), "member_ids");
        assertInvalid(owner, workspaceId,
                group("private-dupe", "PRIVATE", List.of(active.user().id(), active.user().id())),
                "member_ids");
        assertInvalid(owner, workspaceId,
                group("private-foreign", "PRIVATE", List.of(outsider.user().id())),
                "member_ids");
        assertInvalid(owner, workspaceId,
                group("private-unknown", "PRIVATE", List.of(UUID.randomUUID())), "member_ids");

        List<UUID> tooMany = new ArrayList<>();
        for (int index = 0; index < 101; index++) {
            tooMany.add(UUID.randomUUID());
        }
        assertInvalid(owner, workspaceId, group("private-too-many", "PRIVATE", tooMany),
                "member_ids");

        // PUBLIC never accepts an explicit audience; visibility/member_ids are GROUP-only.
        assertInvalid(owner, workspaceId,
                group("public-with-members", "PUBLIC", List.of(active.user().id())),
                "member_ids");
        assertInvalid(owner, workspaceId, group("bad-visibility", "SECRET", List.of()),
                "visibility");
        assertInvalid(owner, workspaceId, direct(active.user().id(), "PRIVATE", null),
                "visibility");
        assertInvalid(owner, workspaceId, direct(active.user().id(), null,
                List.of(active.user().id())), "member_ids");

        // A rejected create consumes neither a limit slot nor a channel row.
        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM chat.chats WHERE workspace_id = ? AND type = 'GROUP'
                """, Long.class, workspaceId)).isEqualTo(1L);
    }

    @Test
    void anyActiveMemberCanCreateGroupWithinInstallationLimits() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("vis-limit-owner"));
        SessionResponse member = devSession(uniqueDisplayName("vis-limit-member"));
        UUID workspaceId = owner.workspace().id();
        addMember(owner, workspaceId, emailOf(member.user().id()), "MEMBER")
                .andExpect(status().isCreated());
        assertThat(workspaceRole(workspaceId, member.user().id())).isEqualTo("MEMBER");

        // The default PUBLIC chat is already one chat for the member.
        setChatLimits(1, 1000);
        MvcResult limited = createChat(member, workspaceId, group("member-over-limit"))
                .andExpect(status().isConflict())
                .andReturn();
        JsonNode error = json(limited);
        CONTRACT.assertValid("Error", error);
        assertThat(error.get("code").asText()).isEqualTo("CHAT_LIMIT_REACHED");
        assertThat(error.at("/details/scope").asText()).isEqualTo("USER");

        setChatLimits(100, 1000);
        MvcResult created = createChat(member, workspaceId, group("member-created"))
                .andExpect(status().isCreated())
                .andReturn();
        JsonNode createdChat = json(created);
        assertThat(createdChat.get("visibility").asText()).isEqualTo("PUBLIC");
        UUID createdId = UUID.fromString(createdChat.get("id").asText());
        assertThat(member(createdId, member.user().id()).get("role")).isEqualTo("OWNER");
    }

    @Test
    void newWorkspaceMemberJoinsPublicChannelsAndNeverPrivateOnes() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("vis-join-owner"));
        SessionResponse early = devSession(uniqueDisplayName("vis-join-early"));
        SessionResponse late = devSession(uniqueDisplayName("vis-join-late"));
        UUID workspaceId = owner.workspace().id();

        addMember(owner, workspaceId, emailOf(early.user().id()), "MEMBER")
                .andExpect(status().isCreated());
        // The default «Общий чат» and both explicit public channels are PUBLIC.
        UUID firstPublic = createGroup(owner, workspaceId, group("join-public-one"));
        UUID secondPublic = createGroup(owner, workspaceId, group("join-public-two"));
        UUID privateChat = createGroup(owner, workspaceId,
                group("join-private", "PRIVATE", List.of(early.user().id())));

        Map<String, Object> earlyPrivate = member(privateChat, early.user().id());
        assertThat(earlyPrivate.get("role")).isEqualTo("MEMBER");

        addMember(owner, workspaceId, emailOf(late.user().id()), "MEMBER")
                .andExpect(status().isCreated());

        // The new member is in every public channel, including one created before the join.
        assertThat(memberRow(owner.chat().id(), late.user().id()).get("status"))
                .isEqualTo("ACTIVE");
        assertThat(memberRow(firstPublic, late.user().id()).get("status")).isEqualTo("ACTIVE");
        assertThat(memberRow(secondPublic, late.user().id()).get("status")).isEqualTo("ACTIVE");
        assertThat(memberRow(privateChat, late.user().id())).isNull();

        List<JsonNode> items = new ArrayList<>();
        chatList(late, workspaceId).get("items").forEach(items::add);
        assertThat(items).anySatisfy(item -> {
            assertThat(item.get("id").asText()).isEqualTo(firstPublic.toString());
            assertThat(item.get("visibility").asText()).isEqualTo("PUBLIC");
        });
        assertThat(items).noneSatisfy(item ->
                assertThat(item.get("id").asText()).isEqualTo(privateChat.toString()));
        assertThat(visibilityRow(privateChat)).isEqualTo("PRIVATE");
    }

    @Test
    void channelSettingsAreRlsScopedAndBackfilledAsPublic() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("vis-rls-owner"));
        SessionResponse outsider = devSession(uniqueDisplayName("vis-rls-outsider"));

        // The onboarding default channel gets an explicit PUBLIC settings row.
        assertThat(visibilityRow(owner.chat().id())).isEqualTo("PUBLIC");

        assertThat(migrator().queryForObject("""
                SELECT relrowsecurity AND relforcerowsecurity
                  FROM pg_class WHERE oid = 'chat.channel_settings'::regclass
                """, Boolean.class)).isTrue();
        assertThat(migrator().queryForObject("""
                SELECT has_table_privilege('krug_app', 'chat.channel_settings', 'SELECT')
                   AND has_table_privilege('krug_app', 'chat.channel_settings', 'INSERT')
                """, Boolean.class)).isTrue();

        // Another tenant cannot see the settings row even though chat_id is the only key.
        Long visible = inTenant(outsider.user().id(), outsider.workspace().id(), () ->
                jdbc.queryForObject("""
                        SELECT count(*) FROM chat.channel_settings WHERE chat_id = ?
                        """, Long.class, owner.chat().id()));
        assertThat(visible).isZero();

        // Every live GROUP chat has a settings row; DIRECT has none.
        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM chat.chats c
                  LEFT JOIN chat.channel_settings cs ON cs.chat_id = c.id
                 WHERE c.workspace_id = ?
                   AND c.type = 'GROUP' AND c.deleted_at IS NULL AND cs.chat_id IS NULL
                """, Long.class, owner.workspace().id())).isZero();
        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM chat.channel_settings cs
                  JOIN chat.chats c ON c.id = cs.chat_id
                 WHERE c.workspace_id = ? AND c.type = 'DIRECT'
                """, Long.class, owner.workspace().id())).isZero();

        // The backfill statement is idempotent for a pre-V39 GROUP row.
        UUID legacy = UUID.randomUUID();
        migrator().update("""
                INSERT INTO chat.chats (id, workspace_id, type, security_mode, name, created_by)
                VALUES (?, ?, 'GROUP', 'MANAGED', 'legacy-backfill', ?)
                """, legacy, owner.workspace().id(), owner.user().id());
        assertThat(visibilityRow(legacy)).isNull();
        migrator().update("""
                INSERT INTO chat.channel_settings (chat_id, visibility, created_at)
                SELECT c.id, 'PUBLIC', COALESCE(c.created_at, now())
                  FROM chat.chats c WHERE c.type = 'GROUP'
                ON CONFLICT (chat_id) DO NOTHING
                """);
        assertThat(visibilityRow(legacy)).isEqualTo("PUBLIC");
    }

    // ------------------------------------------------------------------

    private MockHttpServletRequestBuilder authedCreate(SessionResponse session, UUID workspaceId,
                                                       Map<String, Object> body)
            throws Exception {
        return authed(post("/api/v1/workspaces/{workspaceId}/chats", workspaceId), session)
                .header("Idempotency-Key", UUID.randomUUID().toString())
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(body));
    }

    private org.springframework.test.web.servlet.ResultActions createChat(
            SessionResponse session, UUID workspaceId, Map<String, Object> body)
            throws Exception {
        return mockMvc.perform(authedCreate(session, workspaceId, body));
    }

    private UUID createGroup(SessionResponse session, UUID workspaceId,
                             Map<String, Object> body) throws Exception {
        MvcResult result = createChat(session, workspaceId, body)
                .andExpect(status().isCreated())
                .andReturn();
        return UUID.fromString(json(result).get("id").asText());
    }

    private void assertInvalid(SessionResponse session, UUID workspaceId,
                               Map<String, Object> body, String field) throws Exception {
        MvcResult result = createChat(session, workspaceId, body)
                .andExpect(status().isBadRequest())
                .andReturn();
        JsonNode error = json(result);
        CONTRACT.assertValid("Error", error);
        assertThat(error.get("code").asText()).isEqualTo("VALIDATION_FAILED");
        JsonNode details = error.get("details");
        boolean identified = details.has(field)
                || field.equals(details.path("field").asText());
        assertThat(identified).as("details identify %s: %s", field, details).isTrue();
    }

    private org.springframework.test.web.servlet.ResultActions addMember(
            SessionResponse owner, UUID workspaceId, String email, String role) throws Exception {
        return mockMvc.perform(authed(
                        post("/api/v1/workspaces/{workspaceId}/members", workspaceId), owner)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(Map.of(
                        "email", email, "role", role))));
    }

    private static Map<String, Object> group(String name) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("type", "GROUP");
        body.put("name", name + "-" + UUID.randomUUID());
        return body;
    }

    private static Map<String, Object> group(String name, String visibility,
                                             List<UUID> memberIds) {
        Map<String, Object> body = group(name);
        body.put("visibility", visibility);
        body.put("member_ids", memberIds);
        return body;
    }

    private static Map<String, Object> direct(UUID peerId, String visibility,
                                              List<UUID> memberIds) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("type", "DIRECT");
        body.put("peer_id", peerId);
        if (visibility != null) {
            body.put("visibility", visibility);
        }
        if (memberIds != null) {
            body.put("member_ids", memberIds);
        }
        return body;
    }

    private JsonNode chatList(SessionResponse session, UUID workspaceId) throws Exception {
        MvcResult result = mockMvc.perform(authed(
                        get("/api/v1/workspaces/{workspaceId}/chats", workspaceId), session))
                .andExpect(status().isOk())
                .andReturn();
        return json(result);
    }

    private JsonNode chatInList(SessionResponse session, UUID workspaceId, UUID chatId)
            throws Exception {
        for (JsonNode item : chatList(session, workspaceId).get("items")) {
            if (item.get("id").asText().equals(chatId.toString())) {
                return item;
            }
        }
        throw new AssertionError("chat not found in list: " + chatId);
    }

    private Map<String, Object> member(UUID chatId, UUID userId) {
        Map<String, Object> row = memberRow(chatId, userId);
        assertThat(row).as("membership %s/%s", chatId, userId).isNotNull();
        return row;
    }

    private Map<String, Object> memberRow(UUID chatId, UUID userId) {
        List<Map<String, Object>> rows = migrator().queryForList("""
                SELECT role, status FROM chat.chat_members
                 WHERE chat_id = ? AND user_id = ?
                """, chatId, userId);
        return rows.isEmpty() ? null : rows.get(0);
    }

    private String visibilityRow(UUID chatId) {
        List<String> rows = migrator().queryForList("""
                SELECT visibility FROM chat.channel_settings WHERE chat_id = ?
                """, String.class, chatId);
        return rows.isEmpty() ? null : rows.get(0);
    }

    private String workspaceRole(UUID workspaceId, UUID userId) {
        return migrator().queryForObject("""
                SELECT role FROM workspace.memberships
                 WHERE workspace_id = ? AND user_id = ? AND status = 'ACTIVE'
                """, String.class, workspaceId, userId);
    }

    private String emailOf(UUID userId) {
        return migrator().queryForObject(
                "SELECT email::text FROM auth.users WHERE id = ?", String.class, userId);
    }

    private void setChatLimits(int perUser, int perWorkspace) {
        migrator().update("""
                UPDATE ops.system_settings
                   SET max_chats_per_user = ?, max_chats_per_workspace = ?
                 WHERE id = 1
                """, perUser, perWorkspace);
    }

    private Map<String, Object> auditEvent(UUID chatId) {
        return migrator().queryForMap("""
                SELECT actor_id, target_type, target_id, metadata::text AS metadata
                  FROM audit.audit_events
                 WHERE action = 'chat.created' AND target_id = ?
                 ORDER BY created_at DESC, id DESC
                 LIMIT 1
                """, chatId);
    }
}
