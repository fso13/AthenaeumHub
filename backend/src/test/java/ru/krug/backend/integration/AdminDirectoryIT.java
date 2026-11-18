package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.support.IntegrationTestBase;
import ru.krug.backend.support.OpenApiContract;

/**
 * E9-B end-to-end: platform-admin user/chat lists and the storage dashboard. Covers
 * cursor pagination, literal search, workspace/type filters, limits, forbidden access,
 * audit reads, and the absence of message/file content in every admin response.
 */
@ActiveProfiles("test")
class AdminDirectoryIT extends IntegrationTestBase {

    private static final OpenApiContract CONTRACT = OpenApiContract.load();

    @BeforeEach
    void resetSettings() {
        migrator().update("""
                UPDATE ops.system_settings
                   SET max_chats_per_user = 100,
                       max_chats_per_workspace = 1000,
                       max_workspace_members = 100,
                       registration_open = true,
                       updated_at = now()
                 WHERE id = 1
                """);
    }

    @Test
    void usersPageSupportsLiteralSearchPaginationAndLimitValidation() throws Exception {
        SessionResponse admin = adminSession();
        String prefix = "adm-users-" + UUID.randomUUID().toString().substring(0, 8);
        List<UUID> created = new ArrayList<>();
        for (int i = 0; i < 3; i++) {
            SessionResponse user = devSession(prefix + "-" + i);
            migrator().update("UPDATE auth.users SET email = ? WHERE id = ?",
                    prefix + "-" + i + "@example.test", user.user().id());
            created.add(user.user().id());
        }

        JsonNode first = usersPage(admin, prefix, null, 2);
        CONTRACT.assertValid("AdminUserPage", first);
        assertThat(first.get("has_more").asBoolean()).isTrue();
        assertThat(first.get("items")).hasSize(2);
        assertThat(first.get("next_cursor").isNull()).isFalse();

        JsonNode sample = first.get("items").get(0);
        assertThat(sample.get("status").asText()).isEqualTo("ACTIVE");
        assertThat(sample.get("is_platform_admin").isBoolean()).isTrue();
        assertThat(sample.get("workspaces_count").asLong()).isGreaterThanOrEqualTo(1);
        assertThat(sample.get("chats_count").asLong()).isGreaterThanOrEqualTo(1);
        assertThat(sample.get("storage_used_bytes").asLong()).isGreaterThanOrEqualTo(0);
        assertThat(sample.get("created_at").isNull()).isFalse();

        JsonNode second = usersPage(admin, prefix, first.get("next_cursor").asText(), 2);
        CONTRACT.assertValid("AdminUserPage", second);
        assertThat(second.get("items")).hasSize(1);
        assertThat(second.get("has_more").asBoolean()).isFalse();
        assertThat(second.get("next_cursor").isNull()).isTrue();

        Set<UUID> paged = new LinkedHashSet<>(ids(first));
        paged.addAll(ids(second));
        assertThat(paged).containsExactlyInAnyOrderElementsOf(created);

        JsonNode byEmail = usersPage(admin, prefix + "-1@example.test", null, 100);
        CONTRACT.assertValid("AdminUserPage", byEmail);
        assertThat(byEmail.get("items")).hasSize(1);
        assertThat(byEmail.at("/items/0/id").asText()).isEqualTo(created.get(1).toString());
        assertThat(byEmail.at("/items/0/email").asText())
                .isEqualTo(prefix + "-1@example.test");

        JsonNode none = usersPage(admin, prefix + "-missing", null, 100);
        assertThat(none.get("items")).isEmpty();
        assertThat(none.get("has_more").asBoolean()).isFalse();

        assertValidationFailed(authed(get("/api/v1/admin/users").param("limit", "0"), admin));
        assertValidationFailed(authed(get("/api/v1/admin/users").param("limit", "101"), admin));
        assertValidationFailed(authed(get("/api/v1/admin/users").param("cursor", "garbage"),
                admin));
        assertValidationFailed(authed(get("/api/v1/admin/users").param("query", "x".repeat(255)),
                admin));
    }

    @Test
    void chatsPageSupportsWorkspaceTypeAndNameFiltersWithStablePagination() throws Exception {
        SessionResponse admin = adminSession();
        // Guarantee a second user so the "users cursor on chats" probe has a next page.
        devSession(uniqueDisplayName("cursor-extra"));
        String prefix = "adm-chats-" + UUID.randomUUID().toString().substring(0, 8);
        UUID first = createGroup(admin, prefix + "-one");
        UUID second = createGroup(admin, prefix + "-two");
        String secretText = "SECRET-MESSAGE-" + UUID.randomUUID();
        sendMessage(admin, first, UUID.randomUUID().toString(), UUID.randomUUID().toString(),
                secretText);

        MvcResult result = mockMvc.perform(authed(get("/api/v1/admin/chats"), admin)
                        .param("workspace_id", admin.workspace().id().toString())
                        .param("query", prefix)
                        .param("limit", "100"))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode page = json(result);
        CONTRACT.assertValid("AdminChatPage", page);
        assertThat(page.get("items")).hasSize(2);
        assertThat(result.getResponse().getContentAsString()).doesNotContain(secretText);

        JsonNode one = itemById(page, first);
        assertThat(one.get("type").asText()).isEqualTo("GROUP");
        assertThat(one.get("security_mode").asText()).isEqualTo("MANAGED");
        assertThat(one.get("workspace_id").asText())
                .isEqualTo(admin.workspace().id().toString());
        assertThat(one.get("workspace_name").asText()).isEqualTo(admin.workspace().name());
        assertThat(one.get("members_count").asLong()).isEqualTo(1);
        assertThat(one.get("messages_count").asLong()).isEqualTo(1);
        assertThat(one.get("last_activity_at").isNull()).isFalse();

        JsonNode two = itemById(page, second);
        assertThat(two.get("messages_count").asLong()).isZero();
        assertThat(two.get("last_activity_at").isNull()).isTrue();

        JsonNode groups = chatsPage(admin, admin.workspace().id(), prefix, "GROUP", null, 100);
        assertThat(groups.get("items")).hasSize(2);
        JsonNode directs = chatsPage(admin, admin.workspace().id(), prefix, "DIRECT", null, 100);
        assertThat(directs.get("items")).isEmpty();

        assertValidationFailed(authed(get("/api/v1/admin/chats").param("type", "CHANNEL"), admin));
        assertValidationFailed(authed(get("/api/v1/admin/chats").param("limit", "0"), admin));
        assertValidationFailed(authed(get("/api/v1/admin/chats").param("limit", "101"), admin));

        JsonNode pageOne = chatsPage(admin, admin.workspace().id(), prefix, null, null, 1);
        assertThat(pageOne.get("items")).hasSize(1);
        assertThat(pageOne.get("has_more").asBoolean()).isTrue();
        JsonNode pageTwo = chatsPage(admin, admin.workspace().id(), prefix, null,
                pageOne.get("next_cursor").asText(), 1);
        assertThat(pageTwo.get("items")).hasSize(1);
        assertThat(pageTwo.get("has_more").asBoolean()).isFalse();
        assertThat(ids(pageTwo)).doesNotContainAnyElementsOf(ids(pageOne));

        // A users cursor is not a chats cursor.
        JsonNode users = usersPage(admin, null, null, 1);
        assertThat(users.get("has_more").asBoolean()).isTrue();
        assertValidationFailed(authed(get("/api/v1/admin/chats")
                .param("cursor", users.get("next_cursor").asText()), admin));
    }

    @Test
    void storageDashboardReturnsTotalsAndPerWorkspaceRowsWithoutFileDetails() throws Exception {
        SessionResponse admin = adminSession();
        UUID workspaceId = admin.workspace().id();
        UUID chatId = admin.chat().id();
        String filename = "secret-file-" + UUID.randomUUID() + ".bin";
        insertAttachment(workspaceId, chatId, admin.user().id(), 1024, "BOUND", filename);
        insertAttachment(workspaceId, chatId, admin.user().id(), 2048, "QUARANTINED", filename);
        migrator().update("""
                INSERT INTO file.workspace_limits (workspace_id) VALUES (?)
                ON CONFLICT (workspace_id) DO NOTHING
                """, workspaceId);
        migrator().update("""
                INSERT INTO file.workspace_usage (workspace_id, used_bytes, reserved_bytes)
                VALUES (?, 1024, 2048)
                ON CONFLICT (workspace_id) DO UPDATE
                   SET used_bytes = EXCLUDED.used_bytes,
                       reserved_bytes = EXCLUDED.reserved_bytes
                """, workspaceId);

        MvcResult filteredResult = mockMvc.perform(authed(get("/api/v1/admin/storage"), admin)
                        .param("workspace_id", workspaceId.toString()))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode filtered = json(filteredResult);
        CONTRACT.assertValid("AdminStorage", filtered);
        assertThat(filtered.at("/totals/used_bytes").asLong()).isEqualTo(1024);
        assertThat(filtered.at("/totals/reserved_bytes").asLong()).isEqualTo(2048);
        assertThat(filtered.at("/totals/objects").asLong()).isEqualTo(1);
        assertThat(filtered.at("/totals/attachments").asLong()).isEqualTo(2);
        assertThat(filtered.get("workspaces")).hasSize(1);
        JsonNode row = filtered.get("workspaces").get(0);
        assertThat(row.get("workspace_id").asText()).isEqualTo(workspaceId.toString());
        assertThat(row.get("workspace_name").asText()).isEqualTo(admin.workspace().name());
        assertThat(row.get("used_bytes").asLong()).isEqualTo(1024);
        assertThat(row.get("reserved_bytes").asLong()).isEqualTo(2048);
        assertThat(row.get("storage_limit_bytes").asLong())
                .isEqualTo(1024L * 1024 * 1024 * 1024);
        assertThat(filteredResult.getResponse().getContentAsString()).doesNotContain(filename);
        assertThat(filteredResult.getResponse().getContentAsString()).doesNotContain("obj-");

        MvcResult allResult = mockMvc.perform(authed(get("/api/v1/admin/storage"), admin))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode all = json(allResult);
        CONTRACT.assertValid("AdminStorage", all);
        JsonNode ours = null;
        for (JsonNode workspace : all.get("workspaces")) {
            if (workspace.get("workspace_id").asText().equals(workspaceId.toString())) {
                ours = workspace;
            }
        }
        assertThat(ours).as("workspace row").isNotNull();
        assertThat(ours.get("used_bytes").asLong()).isEqualTo(1024);
        assertThat(all.at("/totals/used_bytes").asLong())
                .isGreaterThanOrEqualTo(1024);
        assertTotalsAreSumOfRows(all);
    }

    @Test
    void nonAdminGetsForbiddenOnEveryAdminList() throws Exception {
        adminSession();
        SessionResponse regular = devSession(uniqueDisplayName("regular"));

        for (String path : List.of("/api/v1/admin/users", "/api/v1/admin/chats",
                "/api/v1/admin/storage")) {
            MvcResult result = mockMvc.perform(authed(get(path), regular))
                    .andExpect(status().isForbidden())
                    .andReturn();
            assertThat(json(result).get("code").asText()).isEqualTo("FORBIDDEN");
        }
    }

    @Test
    void adminReadsAreAuditedWithCountsOnlyAndNeverStoreSearchOrContent() throws Exception {
        SessionResponse admin = adminSession();
        String prefix = "adm-audit-" + UUID.randomUUID().toString().substring(0, 8);
        SessionResponse target = devSession(prefix);
        String email = prefix + "@example.test";
        migrator().update("UPDATE auth.users SET email = ? WHERE id = ?", email,
                target.user().id());

        UUID chatId = createGroup(admin, prefix + "-chat");
        String secretText = "SECRET-AUDIT-" + UUID.randomUUID();
        sendMessage(admin, chatId, UUID.randomUUID().toString(), UUID.randomUUID().toString(),
                secretText);

        usersPage(admin, email, null, 30);
        chatsPage(admin, admin.workspace().id(), prefix, null, null, 30);
        mockMvc.perform(authed(get("/api/v1/admin/storage"), admin))
                .andExpect(status().isOk());

        List<Map<String, Object>> events = migrator().queryForList("""
                SELECT action, metadata::text AS metadata
                  FROM audit.audit_events
                 WHERE actor_id = ? AND action LIKE 'admin.%'
                 ORDER BY seq
                """, admin.user().id());
        assertThat(events).extracting(event -> event.get("action"))
                .contains("admin.users.viewed", "admin.chats.viewed", "admin.storage.viewed");

        String metadata = events.stream()
                .map(event -> String.valueOf(event.get("metadata")))
                .reduce("", (left, right) -> left + " " + right);
        assertThat(metadata).contains("returned", "has_more", "workspaces");
        assertThat(metadata).doesNotContain(email, prefix, secretText);
        assertThat(metadata).doesNotContain("query");
    }

    @Test
    void adminAggregatesAreSecurityDefinerReadOnlyAndNotExecutableByPublic() {
        List<Map<String, Object>> functions = migrator().queryForList("""
                SELECT p.proname,
                       p.prosecdef,
                       p.provolatile,
                       EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0)
                           AS public_execute
                  FROM pg_proc p
                  JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'ops'
                   AND p.proname IN ('admin_users_page', 'admin_chats_page',
                                     'admin_storage_workspaces')
                """);
        assertThat(functions).hasSize(3);
        for (Map<String, Object> function : functions) {
            assertThat(function.get("prosecdef")).as("security definer: " + function.get("proname"))
                    .isEqualTo(true);
            assertThat(function.get("provolatile"))
                    .as("read-only volatility: " + function.get("proname")).isEqualTo("s");
            assertThat(function.get("public_execute"))
                    .as("PUBLIC execute: " + function.get("proname")).isEqualTo(false);
        }
    }

    private SessionResponse adminSession() throws Exception {
        SessionResponse session = devSession(uniqueDisplayName("admin"));
        // A partial unique index backs "at most one admin", so the old admin must be
        // demoted before the new one is promoted (PostgreSQL checks the index per row).
        migrator().update("UPDATE auth.users SET is_platform_admin = false "
                + "WHERE is_platform_admin");
        migrator().update("UPDATE auth.users SET is_platform_admin = true WHERE id = ?",
                session.user().id());
        return session;
    }

    private JsonNode usersPage(SessionResponse session, String query, String cursor,
                               Integer limit) throws Exception {
        MockHttpServletRequestBuilder request = authed(get("/api/v1/admin/users"), session);
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
        return json(result);
    }

    private JsonNode chatsPage(SessionResponse session, UUID workspaceId, String query,
                               String type, String cursor, Integer limit) throws Exception {
        MockHttpServletRequestBuilder request = authed(get("/api/v1/admin/chats"), session);
        if (workspaceId != null) {
            request.param("workspace_id", workspaceId.toString());
        }
        if (query != null) {
            request.param("query", query);
        }
        if (type != null) {
            request.param("type", type);
        }
        if (cursor != null) {
            request.param("cursor", cursor);
        }
        if (limit != null) {
            request.param("limit", limit.toString());
        }
        MvcResult result = mockMvc.perform(request).andExpect(status().isOk()).andReturn();
        return json(result);
    }

    private void assertValidationFailed(MockHttpServletRequestBuilder request) throws Exception {
        MvcResult result = mockMvc.perform(request)
                .andExpect(status().isBadRequest())
                .andReturn();
        assertThat(json(result).get("code").asText()).isEqualTo("VALIDATION_FAILED");
    }

    private UUID createGroup(SessionResponse session, String name) throws Exception {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("type", "GROUP");
        body.put("name", name);
        MvcResult result = mockMvc.perform(authed(post("/api/v1/workspaces/{id}/chats",
                        session.workspace().id()), session)
                        .header("Idempotency-Key", UUID.randomUUID().toString())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(body)))
                .andExpect(status().isCreated())
                .andReturn();
        return UUID.fromString(json(result).get("id").asText());
    }

    private void insertAttachment(UUID workspaceId, UUID chatId, UUID userId, long size,
                                  String status, String filename) {
        UUID uploadId = UUID.randomUUID();
        UUID attachmentId = UUID.randomUUID();
        String objectKey = "obj-" + attachmentId;
        migrator().update("""
                INSERT INTO file.uploads
                       (id, workspace_id, chat_id, user_id, filename, size_bytes, status,
                        part_size, total_parts, object_key, expires_at)
                VALUES (?, ?, ?, ?, ?, ?, 'BOUND', ?, 1, ?, now() + interval '1 day')
                """, uploadId, workspaceId, chatId, userId, filename, size,
                Math.max(size, 1), objectKey);
        migrator().update("""
                INSERT INTO file.attachments
                       (id, workspace_id, chat_id, upload_id, user_id, filename, size_bytes,
                        sha256, object_key, status, scan_status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, attachmentId, workspaceId, chatId, uploadId, userId, filename, size,
                "a".repeat(64), objectKey, status,
                "QUARANTINED".equals(status) ? "INFECTED" : "CLEAN");
    }

    private static List<UUID> ids(JsonNode page) {
        List<UUID> ids = new ArrayList<>();
        page.get("items").forEach(item -> ids.add(UUID.fromString(item.get("id").asText())));
        return ids;
    }

    private static JsonNode itemById(JsonNode page, UUID id) {
        for (JsonNode item : page.get("items")) {
            if (item.get("id").asText().equals(id.toString())) {
                return item;
            }
        }
        throw new AssertionError("item not found: " + id);
    }

    private static void assertTotalsAreSumOfRows(JsonNode storage) {
        long used = 0;
        long reserved = 0;
        long objects = 0;
        long attachments = 0;
        for (JsonNode workspace : storage.get("workspaces")) {
            used += workspace.get("used_bytes").asLong();
            reserved += workspace.get("reserved_bytes").asLong();
            objects += workspace.get("objects").asLong();
            attachments += workspace.get("attachments").asLong();
        }
        assertThat(storage.at("/totals/used_bytes").asLong()).isEqualTo(used);
        assertThat(storage.at("/totals/reserved_bytes").asLong()).isEqualTo(reserved);
        assertThat(storage.at("/totals/objects").asLong()).isEqualTo(objects);
        assertThat(storage.at("/totals/attachments").asLong()).isEqualTo(attachments);
    }
}
