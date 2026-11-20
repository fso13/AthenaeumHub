package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.cache.Cache;
import org.springframework.cache.CacheManager;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MvcResult;

import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.ops.application.port.SystemSettingsPort;
import ru.krug.backend.support.IntegrationTestBase;
import ru.krug.backend.support.MockMailSender;
import ru.krug.backend.support.OpenApiContract;
import ru.krug.backend.support.TestMailConfig;

/**
 * E8-B end-to-end: first admin, first-run setup idempotency, admin guard, encrypted SMTP,
 * registration switch and installation chat limits (including the concurrent boundary).
 */
@ActiveProfiles("test")
@Import(TestMailConfig.class)
@ExtendWith(OutputCaptureExtension.class)
class AdminSettingsIT extends IntegrationTestBase {

    private static final OpenApiContract CONTRACT = OpenApiContract.load();

    @Autowired
    private MockMailSender mail;

    @Autowired
    private CacheManager cacheManager;

    @BeforeEach
    void reset() {
        resetSettings();
        mail.clear();
    }

    @AfterEach
    void cleanup() {
        resetSettings();
    }

    @Test
    void setupStatusIsPublicAndSetupCompletionIsIdempotent() throws Exception {
        MvcResult statusResult = mockMvc.perform(get("/api/v1/setup/status"))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode status = json(statusResult);
        CONTRACT.assertValid("SetupStatus", status);
        assertThat(status.get("setup_required").asBoolean()).isTrue();
        assertThat(status.get("registration_open").asBoolean()).isTrue();

        SessionResponse admin = adminSession();
        String password = "Smtp-Secret-Password-42!";

        Map<String, Object> completeSetup = new LinkedHashMap<>();
        completeSetup.put("smtp_host", "smtp.example.test");
        completeSetup.put("smtp_port", 587);
        completeSetup.put("smtp_username", "sova");
        completeSetup.put("smtp_password", password);
        completeSetup.put("smtp_from", "no-reply@example.test");
        completeSetup.put("smtp_starttls", true);
        completeSetup.put("max_chats_per_user", 7);
        completeSetup.put("max_chats_per_workspace", 70);
        completeSetup.put("max_workspace_members", 12);
        completeSetup.put("registration_open", false);
        completeSetup.put("complete_setup", true);

        MvcResult first = mockMvc.perform(authed(patch("/api/v1/admin/settings"), admin)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(completeSetup)))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode completed = json(first);
        CONTRACT.assertValid("AdminSettings", completed);
        assertThat(completed.get("setup_completed").asBoolean()).isTrue();
        assertThat(completed.get("setup_completed_at").isNull()).isFalse();
        assertThat(completed.get("max_chats_per_user").asInt()).isEqualTo(7);
        assertThat(completed.get("smtp_configured").asBoolean()).isTrue();
        assertThat(first.getResponse().getContentAsString()).doesNotContain(password);
        assertThat(completed.has("smtp_password")).isFalse();

        // Fresh install status now says setup is done.
        JsonNode after = json(mockMvc.perform(get("/api/v1/setup/status"))
                .andExpect(status().isOk()).andReturn());
        assertThat(after.get("setup_required").asBoolean()).isFalse();
        assertThat(after.get("registration_open").asBoolean()).isFalse();

        MvcResult repeated = mockMvc.perform(authed(patch("/api/v1/admin/settings"), admin)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"complete_setup\":true}"))
                .andExpect(status().isConflict())
                .andReturn();
        assertThat(json(repeated).get("code").asText())
                .isEqualTo("SETUP_ALREADY_COMPLETED");

        // Regular updates after completion are allowed and idempotent.
        mockMvc.perform(authed(patch("/api/v1/admin/settings"), admin)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"max_chats_per_user\":9}"))
                .andExpect(status().isOk());
        JsonNode settings = json(mockMvc.perform(authed(get("/api/v1/admin/settings"), admin))
                .andExpect(status().isOk()).andReturn());
        CONTRACT.assertValid("AdminSettings", settings);
        assertThat(settings.get("max_chats_per_user").asInt()).isEqualTo(9);

        // Audit is written without the SMTP secret.
        List<String> actions = migrator().queryForList(
                "SELECT action FROM audit.audit_events WHERE actor_id = ? ORDER BY seq",
                String.class, admin.user().id());
        assertThat(actions).contains("settings.updated", "setup.completed");
        String metadata = migrator().queryForObject("""
                SELECT string_agg(metadata::text, ' ')
                  FROM audit.audit_events WHERE actor_id = ?
                """, String.class, admin.user().id());
        assertThat(metadata).doesNotContain(password);
    }

    @Test
    void firstLocalUserIsPlatformAdminAndOnlyOneAdminExists() throws Exception {
        migrator().update("UPDATE auth.users SET is_platform_admin = false");

        SessionResponse first = devSession(uniqueDisplayName("first"));
        SessionResponse second = devSession(uniqueDisplayName("second"));

        assertThat(meFlag(first)).isTrue();
        assertThat(meFlag(second)).isFalse();
        Integer admins = migrator().queryForObject(
                "SELECT count(*) FROM auth.users WHERE is_platform_admin", Integer.class);
        assertThat(admins).isEqualTo(1);
    }

    @Test
    void nonAdminGetsForbiddenOnEveryAdminEndpoint() throws Exception {
        adminSession();
        SessionResponse regular = devSession(uniqueDisplayName("regular"));

        mockMvc.perform(authed(get("/api/v1/admin/settings"), regular))
                .andExpect(status().isForbidden());
        mockMvc.perform(authed(patch("/api/v1/admin/settings"), regular)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"registration_open\":false}"))
                .andExpect(status().isForbidden());
        mockMvc.perform(authed(get("/api/v1/admin/overview"), regular))
                .andExpect(status().isForbidden());
        mockMvc.perform(authed(post("/api/v1/admin/settings/test-email"), regular)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"to\":\"admin@example.test\"}"))
                .andExpect(status().isForbidden());

        MvcResult settings = mockMvc.perform(authed(get("/api/v1/admin/settings"), regular))
                .andExpect(status().isForbidden()).andReturn();
        assertThat(json(settings).get("code").asText()).isEqualTo("FORBIDDEN");
    }

    @Test
    void smtpPasswordIsEncryptedAtRestAndNeverExposed(CapturedOutput output) throws Exception {
        SessionResponse admin = adminSession();
        String password = "Very-Secret-Smtp-Password-987";

        MvcResult patchResult = mockMvc.perform(authed(patch("/api/v1/admin/settings"), admin)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "smtp_host", "smtp.example.test",
                                "smtp_port", 587,
                                "smtp_username", "sova",
                                "smtp_password", password,
                                "smtp_from", "no-reply@example.test",
                                "smtp_starttls", true))))
                .andExpect(status().isOk())
                .andReturn();
        assertThat(patchResult.getResponse().getContentAsString()).doesNotContain(password);

        byte[] ciphertext = migrator().queryForObject(
                "SELECT smtp_password_ciphertext FROM ops.system_settings WHERE id = 1",
                byte[].class);
        assertThat(ciphertext).isNotNull();
        assertThat(new String(ciphertext, java.nio.charset.StandardCharsets.UTF_8))
                .doesNotContain(password);
        assertThat(ciphertext).isNotEqualTo(password.getBytes(java.nio.charset.StandardCharsets.UTF_8));

        MvcResult getResult = mockMvc.perform(authed(get("/api/v1/admin/settings"), admin))
                .andExpect(status().isOk()).andReturn();
        String body = getResult.getResponse().getContentAsString();
        assertThat(body).doesNotContain(password);
        assertThat(body).doesNotContain("smtp_password");

        MvcResult test = mockMvc.perform(authed(post("/api/v1/admin/settings/test-email"), admin)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"to\":\"admin@example.test\"}"))
                .andExpect(status().isAccepted())
                .andReturn();
        CONTRACT.assertValid("TestEmailResponse", json(test));
        assertThat(mail.lastTestEmail()).isEqualTo("admin@example.test");
        assertThat(test.getResponse().getContentAsString()).doesNotContain(password);

        assertThat(output.getAll()).doesNotContain(password);
    }

    @Test
    void requireTwoFactorSettingIsExposedPatchableAndValidated() throws Exception {
        SessionResponse admin = adminSession();

        JsonNode initial = json(mockMvc.perform(authed(get("/api/v1/admin/settings"), admin))
                .andExpect(status().isOk()).andReturn());
        CONTRACT.assertValid("AdminSettings", initial);
        assertThat(initial.get("require_2fa").asBoolean()).isFalse();

        MvcResult enabled = mockMvc.perform(authed(patch("/api/v1/admin/settings"), admin)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"require_2fa\":true}"))
                .andExpect(status().isOk()).andReturn();
        assertThat(json(enabled).get("require_2fa").asBoolean()).isTrue();
        assertThat(migrator().queryForObject(
                "SELECT require_2fa FROM ops.system_settings WHERE id = 1", Boolean.class))
                .isTrue();

        MvcResult disabled = mockMvc.perform(authed(patch("/api/v1/admin/settings"), admin)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"require_2fa\":false}"))
                .andExpect(status().isOk()).andReturn();
        assertThat(json(disabled).get("require_2fa").asBoolean()).isFalse();

        MvcResult invalid = mockMvc.perform(authed(patch("/api/v1/admin/settings"), admin)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"require_2fa\":\"not-a-boolean\"}"))
                .andExpect(status().isBadRequest()).andReturn();
        CONTRACT.assertValid("Error", json(invalid));
        assertThat(json(invalid).get("code").asText()).isEqualTo("VALIDATION_FAILED");
        assertThat(migrator().queryForObject(
                "SELECT require_2fa FROM ops.system_settings WHERE id = 1", Boolean.class))
                .isFalse();

        String metadata = migrator().queryForObject("""
                SELECT string_agg(metadata::text, ' ')
                  FROM audit.audit_events WHERE action = 'settings.updated' AND actor_id = ?
                """, String.class, admin.user().id());
        assertThat(metadata).contains("require_2fa");
    }

    @Test
    void registrationOpenSwitchClosesAuthRegister() throws Exception {
        SessionResponse admin = adminSession();
        mockMvc.perform(authed(patch("/api/v1/admin/settings"), admin)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"registration_open\":false}"))
                .andExpect(status().isOk());

        String body = objectMapper.writeValueAsString(Map.of(
                "email", "new-user@example.test",
                "display_name", "New User",
                "password", "VeryStrongPass123!"));
        MvcResult result = mockMvc.perform(post("/api/v1/auth/register")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isForbidden())
                .andReturn();
        assertThat(json(result).get("code").asText()).isEqualTo("REGISTRATION_CLOSED");
    }

    @Test
    void adminOverviewReturnsAggregateCountsWithoutContent() throws Exception {
        SessionResponse admin = adminSession();
        MvcResult result = mockMvc.perform(authed(get("/api/v1/admin/overview"), admin))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode overview = json(result);
        CONTRACT.assertValid("AdminOverview", overview);
        assertThat(overview.get("users").asLong()).isGreaterThanOrEqualTo(1);
        assertThat(overview.get("workspaces").asLong()).isGreaterThanOrEqualTo(1);
        assertThat(overview.get("chats").asLong()).isGreaterThanOrEqualTo(1);
    }

    @Test
    void userChatLimitIsEnforcedInTheCreateTransaction() throws Exception {
        SessionResponse admin = adminSession();
        patchSettings(admin, "{\"max_chats_per_user\":1,\"max_chats_per_workspace\":1000}");

        JsonNode limits = workspaceLimits(admin);
        CONTRACT.assertValid("WorkspaceLimits", limits);
        assertThat(limits.get("max_chats_per_user").asInt()).isEqualTo(1);
        assertThat(limits.get("chats_used").asLong()).isEqualTo(1);

        MvcResult result = createGroup(admin, "over-user-limit", UUID.randomUUID());
        assertThat(result.getResponse().getStatus()).isEqualTo(409);
        JsonNode error = json(result);
        assertThat(error.get("code").asText()).isEqualTo("CHAT_LIMIT_REACHED");
        assertThat(error.at("/details/scope").asText()).isEqualTo("USER");
        assertThat(error.at("/details/limit").asInt()).isEqualTo(1);
        assertThat(error.at("/details/used").asLong()).isEqualTo(1);
    }

    @Test
    void workspaceChatLimitIsEnforcedAndReportsWorkspaceScope() throws Exception {
        SessionResponse admin = adminSession();
        patchSettings(admin, "{\"max_chats_per_user\":100,\"max_chats_per_workspace\":1}");

        MvcResult result = createGroup(admin, "over-workspace-limit", UUID.randomUUID());
        assertThat(result.getResponse().getStatus()).isEqualTo(409);
        JsonNode error = json(result);
        assertThat(error.get("code").asText()).isEqualTo("CHAT_LIMIT_REACHED");
        assertThat(error.at("/details/scope").asText()).isEqualTo("WORKSPACE");
        assertThat(error.at("/details/limit").asInt()).isEqualTo(1);
        assertThat(error.at("/details/used").asLong()).isEqualTo(1);
    }

    @Test
    void concurrentCreatesCannotBothPassTheWorkspaceBoundary() throws Exception {
        SessionResponse admin = adminSession();
        // The dev workspace already has one default chat; only one more slot is available.
        patchSettings(admin, "{\"max_chats_per_user\":100,\"max_chats_per_workspace\":2}");

        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            List<Callable<Integer>> calls = new ArrayList<>();
            for (int i = 0; i < 2; i++) {
                String name = "race-" + i;
                calls.add(() -> createGroup(admin, name, UUID.randomUUID())
                        .getResponse().getStatus());
            }
            List<Future<Integer>> futures = pool.invokeAll(calls);
            List<Integer> statuses = new ArrayList<>();
            for (Future<Integer> future : futures) {
                statuses.add(future.get());
            }
            assertThat(statuses).containsExactlyInAnyOrder(201, 409);
        } finally {
            pool.shutdownNow();
        }

        Long chats = migrator().queryForObject(
                "SELECT count(*) FROM chat.chats WHERE workspace_id = ? AND deleted_at IS NULL",
                Long.class, admin.workspace().id());
        assertThat(chats).isEqualTo(2);
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

    private boolean meFlag(SessionResponse session) throws Exception {
        JsonNode me = json(mockMvc.perform(authed(get("/api/v1/me"), session))
                .andExpect(status().isOk()).andReturn());
        CONTRACT.assertValid("MeResponse", me);
        return me.at("/user/is_platform_admin").asBoolean();
    }

    private void patchSettings(SessionResponse admin, String body) throws Exception {
        mockMvc.perform(authed(patch("/api/v1/admin/settings"), admin)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isOk());
    }

    private JsonNode workspaceLimits(SessionResponse session) throws Exception {
        MvcResult result = mockMvc.perform(authed(get("/api/v1/workspaces/{id}/limits",
                        session.workspace().id()), session))
                .andExpect(status().isOk())
                .andReturn();
        return json(result);
    }

    private MvcResult createGroup(SessionResponse session, String name, UUID key)
            throws Exception {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("type", "GROUP");
        body.put("name", name);
        return mockMvc.perform(authed(post("/api/v1/workspaces/{id}/chats",
                        session.workspace().id()), session)
                        .header("Idempotency-Key", key.toString())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(body)))
                .andReturn();
    }

    private void resetSettings() {
        migrator().update("""
                UPDATE ops.system_settings
                   SET setup_completed_at = NULL,
                       smtp_host = NULL,
                       smtp_port = NULL,
                       smtp_username = NULL,
                       smtp_password_ciphertext = NULL,
                       smtp_from = NULL,
                       smtp_starttls = true,
                       max_chats_per_user = 100,
                       max_chats_per_workspace = 1000,
                       max_workspace_members = 100,
                       registration_open = true,
                       require_2fa = false,
                       allowed_file_extensions = DEFAULT,
                       updated_by = NULL,
                       updated_at = now()
                 WHERE id = 1
                """);
        // test fixtures bypass the PATCH endpoint, so evict the runtime allowlist cache too.
        Cache cache = cacheManager.getCache(
                SystemSettingsPort.ALLOWED_FILE_EXTENSIONS_CACHE);
        if (cache != null) {
            cache.clear();
        }
    }
}
