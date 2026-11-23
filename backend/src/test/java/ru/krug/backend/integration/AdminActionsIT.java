package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.sql.Timestamp;
import java.time.Instant;
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
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.support.AuthCookieTestSupport;
import ru.krug.backend.support.IntegrationTestBase;
import ru.krug.backend.support.KeycloakWireMock;
import ru.krug.backend.support.OpenApiContract;

/**
 * E11-B end-to-end: platform-admin suspend/activate, chat soft-delete and the audit view.
 * Uses a WireMock Keycloak admin API so the disable/enable + {@code /logout} calls are
 * observable; the application still runs with the test HMAC decoder, so admin calls use
 * dev sessions and Keycloak login/refresh are exercised only where the IdP is the subject.
 */
@SpringBootTest(properties = {
        "krug.auth-bff.keycloak.admin-password=admin-actions-test-admin",
        "krug.auth-bff.rate-limit.login-per-email=100",
        "krug.auth-bff.rate-limit.login-per-ip=1000",
        "krug.auth-bff.rate-limit.register-per-email=100",
        "krug.auth-bff.rate-limit.register-per-ip=1000"
})
@ActiveProfiles("test")
class AdminActionsIT extends IntegrationTestBase {

    private static final OpenApiContract CONTRACT = OpenApiContract.load();
    private static final String PASSWORD = "VeryStrongPass123!";

    @DynamicPropertySource
    static void keycloak(DynamicPropertyRegistry registry) {
        registry.add("krug.auth-bff.keycloak.base-url", KeycloakWireMock::baseUrl);
    }

    @BeforeEach
    void resetFakeIdp() {
        KeycloakWireMock.reset();
    }

    @Test
    void suspendDisablesKeycloakRevokesSessionsAndActivateRestoresLogin() throws Exception {
        SessionResponse admin = adminSession();
        String email = uniqueEmail("e11-suspend");
        KeycloakWireMock.TestUser keycloakUser = KeycloakWireMock.putUser(
                email, "Suspend Target", PASSWORD, true, true);

        MvcResult firstLoginResult = loginResult(email, PASSWORD, 200);
        JsonNode firstLogin = json(firstLoginResult);
        UUID targetId = UUID.fromString(firstLogin.at("/user/id").asText());
        String refreshCookie = AuthCookieTestSupport.value(firstLoginResult);
        assertThat(refreshCookie).isNotBlank();
        assertThat(firstLogin.has("refresh_token")).isFalse();
        assertThat(targetId).isNotEqualTo(admin.user().id());
        assertThat(userStatus(targetId)).isEqualTo("ACTIVE");

        MvcResult suspend = mockMvc.perform(authed(
                        post("/api/v1/admin/users/{userId}/suspend", targetId), admin))
                .andExpect(status().isNoContent())
                .andReturn();
        assertThat(suspend.getResponse().getContentAsString()).isEmpty();

        assertThat(userStatus(targetId)).isEqualTo("SUSPENDED");
        assertThat(KeycloakWireMock.user(email).enabled()).isFalse();
        assertThat(KeycloakWireMock.events())
                .anyMatch(event -> event.startsWith("POST /admin/realms/krug/users/"
                        + keycloakUser.id() + "/logout"));

        // The revoked refresh token no longer rotates, and a disabled user cannot log in.
        MvcResult refresh = mockMvc.perform(AuthCookieTestSupport.withCookie(
                                post("/api/v1/auth/refresh"), refreshCookie)
                        .header(HttpHeaders.ORIGIN, "http://localhost:5173"))
                .andExpect(status().isUnauthorized())
                .andReturn();
        CONTRACT.assertValid("Error", json(refresh));
        assertThat(json(refresh).get("code").asText()).isEqualTo("INVALID_CREDENTIALS");

        JsonNode disabledLogin = login(email, PASSWORD, 403);
        CONTRACT.assertValid("Error", disabledLogin);
        assertThat(disabledLogin.get("code").asText()).isEqualTo("ACCOUNT_SUSPENDED");

        Map<String, Object> suspendedEvent = lastAuditEvent("admin.user.suspended", targetId);
        assertThat(suspendedEvent.get("actor_id")).isEqualTo(admin.user().id());
        assertThat(suspendedEvent.get("target_type")).isEqualTo("user");
        String suspendedMetadata = String.valueOf(suspendedEvent.get("metadata"));
        assertThat(suspendedMetadata).contains("SUSPENDED").doesNotContain(email,
                "Suspend Target");

        MvcResult activate = mockMvc.perform(authed(
                        post("/api/v1/admin/users/{userId}/activate", targetId), admin))
                .andExpect(status().isNoContent())
                .andReturn();
        assertThat(activate.getResponse().getContentAsString()).isEmpty();
        assertThat(userStatus(targetId)).isEqualTo("ACTIVE");
        assertThat(KeycloakWireMock.user(email).enabled()).isTrue();

        JsonNode secondLogin = login(email, PASSWORD, 200);
        assertThat(secondLogin.at("/user/id").asText()).isEqualTo(targetId.toString());

        Map<String, Object> activatedEvent = lastAuditEvent("admin.user.activated", targetId);
        assertThat(activatedEvent.get("actor_id")).isEqualTo(admin.user().id());
        assertThat(String.valueOf(activatedEvent.get("metadata"))).contains("ACTIVE")
                .doesNotContain(email);
    }

    @Test
    void selfSuspendIsRejectedAndTheLastAdminBackstopIsAtomic() throws Exception {
        SessionResponse admin = adminSession();

        MvcResult self = mockMvc.perform(authed(
                        post("/api/v1/admin/users/{userId}/suspend", admin.user().id()), admin))
                .andExpect(status().isConflict())
                .andReturn();
        CONTRACT.assertValid("Error", json(self));
        assertThat(json(self).get("code").asText()).isEqualTo("SELF_ACTION_FORBIDDEN");
        assertThat(userStatus(admin.user().id())).isEqualTo("ACTIVE");

        // The database is the last line of defence, even for a direct SQL caller: the only
        // platform admin cannot be suspended and the status stays ACTIVE.
        Map<String, Object> outcome = migrator().queryForMap(
                "SELECT * FROM ops.admin_set_user_status(?, 'SUSPENDED')",
                admin.user().id());
        assertThat(outcome.get("outcome")).isEqualTo("LAST_ADMIN");
        assertThat(outcome.get("status")).isEqualTo("ACTIVE");
        assertThat(userStatus(admin.user().id())).isEqualTo("ACTIVE");
        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM audit.audit_events
                 WHERE action = 'admin.user.suspended' AND target_id = ?
                """, Integer.class, admin.user().id())).isZero();
    }

    @Test
    void softDeleteHidesTheChatForParticipantsAndAdminButKeepsMessages() throws Exception {
        SessionResponse admin = adminSession();
        SessionResponse owner = devSession(uniqueDisplayName("chat-owner"));
        String chatName = "e11-deleted-" + UUID.randomUUID().toString().substring(0, 8);
        UUID chatId = createGroup(owner, chatName);
        String secret = "SECRET-SOFT-DELETE-" + UUID.randomUUID();
        sendMessage(owner, chatId, UUID.randomUUID().toString(),
                UUID.randomUUID().toString(), secret);
        long messagesBefore = messageCount(chatId);
        assertThat(messagesBefore).isEqualTo(1);

        // The admin is not a member: the delete is cross-tenant through the SECURITY DEFINER
        // function, never through a relaxed RLS policy.
        MvcResult deleted = mockMvc.perform(authed(
                        delete("/api/v1/admin/chats/{chatId}", chatId), admin))
                .andExpect(status().isNoContent())
                .andReturn();
        assertThat(deleted.getResponse().getContentAsString()).isEmpty();
        assertThat(chatDeletedAt(chatId)).isNotNull();
        assertThat(messageCount(chatId)).isEqualTo(messagesBefore);

        assertThat(chatIds(chatList(owner))).doesNotContain(chatId);
        JsonNode adminPage = adminChats(admin, owner.workspace().id(), chatName);
        CONTRACT.assertValid("AdminChatPage", adminPage);
        assertThat(adminPage.get("items")).isEmpty();

        mockMvc.perform(authed(get("/api/v1/chats/{chatId}/messages", chatId), owner))
                .andExpect(status().isNotFound());

        MvcResult repeated = mockMvc.perform(authed(
                        delete("/api/v1/admin/chats/{chatId}", chatId), admin))
                .andExpect(status().isConflict())
                .andReturn();
        CONTRACT.assertValid("Error", json(repeated));
        assertThat(json(repeated).get("code").asText()).isEqualTo("CHAT_ALREADY_DELETED");

        MvcResult unknown = mockMvc.perform(authed(
                        delete("/api/v1/admin/chats/{chatId}", UUID.randomUUID()), admin))
                .andExpect(status().isNotFound())
                .andReturn();
        CONTRACT.assertValid("Error", json(unknown));

        Map<String, Object> event = lastAuditEvent("admin.chat.deleted", chatId);
        assertThat(event.get("target_type")).isEqualTo("chat");
        assertThat(event.get("actor_id")).isEqualTo(admin.user().id());
        String metadata = String.valueOf(event.get("metadata"));
        assertThat(metadata).contains("workspace_id", "members")
                .doesNotContain(chatName, secret);

        // The chat was soft-deleted, never physically removed.
        assertThat(migrator().queryForObject(
                "SELECT count(*) FROM chat.chats WHERE id = ?", Integer.class,
                chatId)).isEqualTo(1);
        assertThat(migrator().queryForObject(
                "SELECT count(*) FROM message.messages WHERE chat_id = ?", Integer.class,
                chatId)).isEqualTo((int) messagesBefore);
    }

    @Test
    void auditPageFiltersPaginatesAndExposesNoMetadataOrContent() throws Exception {
        SessionResponse admin = adminSession();
        List<UUID> suspendedTargets = new ArrayList<>();
        for (int index = 0; index < 3; index++) {
            SessionResponse target = devSession(uniqueDisplayName("audit-target"));
            suspendedTargets.add(target.user().id());
            mockMvc.perform(authed(post("/api/v1/admin/users/{userId}/suspend",
                            target.user().id()), admin))
                    .andExpect(status().isNoContent());
        }

        JsonNode first = auditPage(admin, "admin.user.suspended", null, 2);
        CONTRACT.assertValid("AdminAuditPage", first);
        assertThat(first.get("items")).hasSize(2);
        assertThat(first.get("has_more").asBoolean()).isTrue();
        assertThat(first.get("next_cursor").isNull()).isFalse();
        assertThat(first.get("items").toString()).doesNotContain("metadata",
                "request_id", "prev_hash", "hash");
        first.get("items").forEach(item ->
                assertThat(item.get("action").asText()).isEqualTo("admin.user.suspended"));

        JsonNode second = auditPage(admin, "admin.user.suspended",
                first.get("next_cursor").asText(), 2);
        CONTRACT.assertValid("AdminAuditPage", second);
        Set<UUID> pageOne = auditIds(first);
        Set<UUID> pageTwo = auditIds(second);
        assertThat(pageOne).hasSize(2);
        assertThat(pageTwo).isNotEmpty();
        assertThat(pageTwo).doesNotContainAnyElementsOf(pageOne);
        assertThat(isDescending(first.get("items"), second.get("items"))).isTrue();

        JsonNode all = auditPage(admin, "admin.user.suspended", null, 100);
        assertThat(all.get("items")).hasSizeGreaterThanOrEqualTo(3);
        assertThat(auditTargetIds(all)).containsAll(suspendedTargets);

        // A different action filter returns only that action; the chat delete row carries
        // the actor email (the only PII the contract allows) and no chat name.
        String chatName = "e11-audit-" + UUID.randomUUID().toString().substring(0, 8);
        UUID chatId = createGroup(admin, chatName);
        String secret = "SECRET-AUDIT-CONTENT-" + UUID.randomUUID();
        sendMessage(admin, chatId, UUID.randomUUID().toString(),
                UUID.randomUUID().toString(), secret);
        mockMvc.perform(authed(delete("/api/v1/admin/chats/{chatId}", chatId), admin))
                .andExpect(status().isNoContent());

        MvcResult chatAuditResult = mockMvc.perform(authed(get("/api/v1/admin/audit"), admin)
                        .param("action", "admin.chat.deleted")
                        .param("limit", "100"))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode chatAudit = json(chatAuditResult);
        CONTRACT.assertValid("AdminAuditPage", chatAudit);
        JsonNode chatEvent = itemById(chatAudit, chatId);
        assertThat(chatEvent.get("target_type").asText()).isEqualTo("chat");
        assertThat(chatEvent.get("actor_id").asText()).isEqualTo(admin.user().id().toString());
        assertThat(chatEvent.get("actor_email").asText()).isEqualTo(userEmail(admin.user().id()));
        assertThat(chatAuditResult.getResponse().getContentAsString())
                .doesNotContain(chatName, secret, "\"metadata\"", "\"request_id\"");

        // The audit read itself is audited with counts only (never the action filter).
        long before = auditCount("admin.audit.viewed");
        auditPage(admin, null, null, 1);
        long after = auditCount("admin.audit.viewed");
        assertThat(after).isGreaterThan(before);
        Map<String, Object> viewEvent = migrator().queryForMap("""
                SELECT metadata::text AS metadata
                  FROM audit.audit_events
                 WHERE action = 'admin.audit.viewed'
                 ORDER BY created_at DESC
                 LIMIT 1
                """);
        assertThat(String.valueOf(viewEvent.get("metadata")))
                .contains("returned", "has_more")
                .doesNotContain("admin.user.suspended", chatName);

        assertValidationFailed(authed(get("/api/v1/admin/audit").param("limit", "0"), admin));
        assertValidationFailed(authed(get("/api/v1/admin/audit").param("limit", "101"), admin));
        assertValidationFailed(authed(get("/api/v1/admin/audit")
                .param("action", "a".repeat(121)), admin));
        assertValidationFailed(authed(get("/api/v1/admin/audit")
                .param("cursor", "garbage"), admin));

        // A cursor issued for the users page cannot be replayed against the audit page.
        JsonNode users = json(mockMvc.perform(authed(get("/api/v1/admin/users"), admin)
                        .param("limit", "1"))
                .andExpect(status().isOk())
                .andReturn());
        assertThat(users.get("next_cursor").isNull()).isFalse();
        assertValidationFailed(authed(get("/api/v1/admin/audit")
                .param("cursor", users.get("next_cursor").asText()), admin));
    }

    @Test
    void nonAdminGetsForbiddenBeforeAnyStateChange() throws Exception {
        adminSession();
        SessionResponse regular = devSession(uniqueDisplayName("regular"));
        SessionResponse target = devSession(uniqueDisplayName("target"));

        assertForbidden(post("/api/v1/admin/users/{userId}/suspend", target.user().id()),
                regular);
        assertForbidden(post("/api/v1/admin/users/{userId}/activate", target.user().id()),
                regular);
        assertForbidden(delete("/api/v1/admin/chats/{chatId}", target.chat().id()), regular);
        assertForbidden(get("/api/v1/admin/audit"), regular);

        assertThat(userStatus(target.user().id())).isEqualTo("ACTIVE");
        assertThat(chatDeletedAt(target.chat().id())).isNull();
        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM audit.audit_events
                 WHERE target_id = ? AND action LIKE 'admin.%'
                """, Integer.class, target.user().id())).isZero();
    }

    @Test
    void unknownIdsAre404AndLocalOnlyUsersStillSuspend() throws Exception {
        SessionResponse admin = adminSession();

        assertNotFound(post("/api/v1/admin/users/{userId}/suspend", UUID.randomUUID()), admin);
        assertNotFound(post("/api/v1/admin/users/{userId}/activate", UUID.randomUUID()), admin);
        assertNotFound(delete("/api/v1/admin/chats/{chatId}", UUID.randomUUID()), admin);

        // A dev/test user has no Keycloak account: the IdP step is a no-op, the local
        // status still changes and both transitions are audited.
        SessionResponse local = devSession(uniqueDisplayName("local-only"));
        MvcResult suspend = mockMvc.perform(authed(
                        post("/api/v1/admin/users/{userId}/suspend", local.user().id()), admin))
                .andExpect(status().isNoContent())
                .andReturn();
        assertThat(suspend.getResponse().getContentAsString()).isEmpty();
        assertThat(userStatus(local.user().id())).isEqualTo("SUSPENDED");
        assertThat(KeycloakWireMock.user(userEmail(local.user().id()))).isNull();

        MvcResult alreadySuspended = mockMvc.perform(authed(
                        post("/api/v1/admin/users/{userId}/suspend", local.user().id()), admin))
                .andExpect(status().isConflict())
                .andReturn();
        assertThat(json(alreadySuspended).get("code").asText())
                .isEqualTo("USER_ALREADY_SUSPENDED");

        mockMvc.perform(authed(
                        post("/api/v1/admin/users/{userId}/activate", local.user().id()), admin))
                .andExpect(status().isNoContent());
        assertThat(userStatus(local.user().id())).isEqualTo("ACTIVE");

        MvcResult alreadyActive = mockMvc.perform(authed(
                        post("/api/v1/admin/users/{userId}/activate", local.user().id()), admin))
                .andExpect(status().isConflict())
                .andReturn();
        CONTRACT.assertValid("Error", json(alreadyActive));
        assertThat(json(alreadyActive).get("code").asText()).isEqualTo("USER_ALREADY_ACTIVE");
    }

    @Test
    void adminActionFunctionsAreSecurityDefinerAndNotExecutableByPublic() {
        List<Map<String, Object>> functions = migrator().queryForList("""
                SELECT p.proname,
                       p.prosecdef,
                       p.provolatile,
                       EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0)
                           AS public_execute
                  FROM pg_proc p
                  JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'ops'
                   AND p.proname IN ('admin_user_detail', 'admin_set_user_status',
                                     'admin_soft_delete_chat', 'admin_audit_page')
                """);
        assertThat(functions).hasSize(4);
        for (Map<String, Object> function : functions) {
            assertThat(function.get("prosecdef")).as("security definer: " + function)
                    .isEqualTo(true);
            assertThat(function.get("public_execute")).as("PUBLIC execute: " + function)
                    .isEqualTo(false);
        }

        // The audit trail stays append-only for the runtime role: the hash chain cannot be
        // rewritten or physically deleted through the application connection.
        assertThat(migrator().queryForObject(
                "SELECT has_table_privilege('krug_app', 'audit.audit_events', 'UPDATE')",
                Boolean.class)).isFalse();
        assertThat(migrator().queryForObject(
                "SELECT has_table_privilege('krug_app', 'audit.audit_events', 'DELETE')",
                Boolean.class)).isFalse();
    }

    // ------------------------------------------------------------------ helpers

    private SessionResponse adminSession() throws Exception {
        SessionResponse session = devSession(uniqueDisplayName("admin"));
        migrator().update("UPDATE auth.users SET is_platform_admin = false "
                + "WHERE is_platform_admin");
        migrator().update("UPDATE auth.users SET is_platform_admin = true WHERE id = ?",
                session.user().id());
        return session;
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

    private JsonNode login(String email, String password, int expectedStatus) throws Exception {
        return json(loginResult(email, password, expectedStatus));
    }

    private MvcResult loginResult(String email, String password, int expectedStatus)
            throws Exception {
        return mockMvc.perform(post("/api/v1/auth/login")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "email", email, "password", password))))
                .andExpect(status().is(expectedStatus))
                .andReturn();
    }

    private JsonNode adminChats(SessionResponse admin, UUID workspaceId, String query)
            throws Exception {
        MockHttpServletRequestBuilder request = authed(get("/api/v1/admin/chats"), admin);
        if (workspaceId != null) {
            request.param("workspace_id", workspaceId.toString());
        }
        if (query != null) {
            request.param("query", query);
        }
        return json(mockMvc.perform(request).andExpect(status().isOk()).andReturn());
    }

    private JsonNode auditPage(SessionResponse admin, String action, String cursor, Integer limit)
            throws Exception {
        MockHttpServletRequestBuilder request = authed(get("/api/v1/admin/audit"), admin);
        if (action != null) {
            request.param("action", action);
        }
        if (cursor != null) {
            request.param("cursor", cursor);
        }
        if (limit != null) {
            request.param("limit", limit.toString());
        }
        return json(mockMvc.perform(request).andExpect(status().isOk()).andReturn());
    }

    private void assertForbidden(MockHttpServletRequestBuilder request, SessionResponse session)
            throws Exception {
        MvcResult result = mockMvc.perform(authed(request, session))
                .andExpect(status().isForbidden())
                .andReturn();
        CONTRACT.assertValid("Error", json(result));
        assertThat(json(result).get("code").asText()).isEqualTo("FORBIDDEN");
    }

    private void assertNotFound(MockHttpServletRequestBuilder request, SessionResponse session)
            throws Exception {
        MvcResult result = mockMvc.perform(authed(request, session))
                .andExpect(status().isNotFound())
                .andReturn();
        CONTRACT.assertValid("Error", json(result));
        assertThat(json(result).get("code").asText()).isEqualTo("NOT_FOUND");
    }

    private void assertValidationFailed(MockHttpServletRequestBuilder request) throws Exception {
        MvcResult result = mockMvc.perform(request).andExpect(status().isBadRequest()).andReturn();
        assertThat(json(result).get("code").asText()).isEqualTo("VALIDATION_FAILED");
    }

    private String userStatus(UUID userId) {
        return migrator().queryForObject("SELECT status FROM auth.users WHERE id = ?",
                String.class, userId);
    }

    private String userEmail(UUID userId) {
        return migrator().queryForObject("SELECT email::text FROM auth.users WHERE id = ?",
                String.class, userId);
    }

    private Timestamp chatDeletedAt(UUID chatId) {
        return migrator().queryForObject("SELECT deleted_at FROM chat.chats WHERE id = ?",
                Timestamp.class, chatId);
    }

    private Map<String, Object> lastAuditEvent(String action, UUID targetId) {
        return migrator().queryForMap("""
                SELECT actor_id, target_type, target_id, metadata::text AS metadata
                  FROM audit.audit_events
                 WHERE action = ? AND target_id = ?
                 ORDER BY created_at DESC
                 LIMIT 1
                """, action, targetId);
    }

    private long auditCount(String action) {
        Long count = migrator().queryForObject(
                "SELECT count(*) FROM audit.audit_events WHERE action = ?", Long.class, action);
        return count == null ? 0 : count;
    }

    private static String uniqueEmail(String prefix) {
        return prefix + "-" + UUID.randomUUID().toString().substring(0, 12)
                + "@example.test";
    }

    private static Set<UUID> chatIds(JsonNode chatList) {
        Set<UUID> ids = new LinkedHashSet<>();
        chatList.get("items").forEach(item -> ids.add(UUID.fromString(item.get("id").asText())));
        return ids;
    }

    private static Set<UUID> auditIds(JsonNode page) {
        Set<UUID> ids = new LinkedHashSet<>();
        page.get("items").forEach(item -> ids.add(UUID.fromString(item.get("id").asText())));
        return ids;
    }

    private static Set<UUID> auditTargetIds(JsonNode page) {
        Set<UUID> ids = new LinkedHashSet<>();
        page.get("items").forEach(item -> {
            if (item.get("target_id").isTextual()) {
                ids.add(UUID.fromString(item.get("target_id").asText()));
            }
        });
        return ids;
    }

    private static JsonNode itemById(JsonNode page, UUID id) {
        for (JsonNode item : page.get("items")) {
            if (id.toString().equals(item.path("target_id").asText())) {
                return item;
            }
        }
        throw new AssertionError("audit item not found for target: " + id);
    }

    private static boolean isDescending(JsonNode firstPage, JsonNode secondPage) {
        List<Instant> timestamps = new ArrayList<>();
        firstPage.forEach(item -> timestamps.add(Instant.parse(item.get("created_at").asText())));
        secondPage.forEach(item -> timestamps.add(Instant.parse(item.get("created_at").asText())));
        for (int index = 1; index < timestamps.size(); index++) {
            if (timestamps.get(index - 1).isBefore(timestamps.get(index))) {
                return false;
            }
        }
        return true;
    }
}
