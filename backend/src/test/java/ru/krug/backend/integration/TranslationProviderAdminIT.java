package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MvcResult;

import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.support.IntegrationTestBase;
import ru.krug.backend.support.OpenApiContract;

/**
 * #84: platform-admin translation provider configuration. Covers https-only URL validation,
 * the enable-requires-URL rule, runtime settings, the no-content health probe, idempotent
 * PATCH and the platform-admin gate.
 */
@ActiveProfiles("test")
class TranslationProviderAdminIT extends IntegrationTestBase {

    private static final OpenApiContract CONTRACT = OpenApiContract.load();
    private static final String PROVIDER_URL = "https://127.0.0.1:1/translate";

    @BeforeEach
    void resetSettings() {
        migrator().update("DELETE FROM ops.plugin_translation_settings");
        migrator().update("DELETE FROM audit.audit_events WHERE action LIKE "
                + "'admin.plugin.translate.%'");
    }

    @Test
    void defaultsAndUrlValidation() throws Exception {
        SessionResponse admin = adminSession();

        JsonNode defaults = json(mockMvc.perform(authed(
                        get("/api/v1/admin/plugins/translate"), admin))
                .andExpect(status().isOk()).andReturn());
        CONTRACT.assertValid("TranslationProviderSettings", defaults);
        assertThat(defaults.get("enabled").asBoolean()).isFalse();
        assertThat(defaults.get("url").asText()).isEmpty();
        assertThat(defaults.get("provider").asText()).isEqualTo("AUTO");

        assertError(patchProvider(admin, "{\"url\":\"http://example.test/translate\"}"),
                "TRANSLATION_URL_INVALID");
        assertError(patchProvider(admin,
                "{\"url\":\"https://user:secret@example.test/translate\"}"),
                "TRANSLATION_URL_INVALID");
        assertError(patchProvider(admin,
                "{\"url\":\"https://example.test/translate?api_key=secret\"}"),
                "TRANSLATION_URL_INVALID");
        assertError(patchProvider(admin,
                "{\"url\":\"https://example.test/translate#fragment\"}"),
                "TRANSLATION_URL_INVALID");
        assertError(patchProvider(admin, "{\"enabled\":true}"),
                "TRANSLATION_URL_REQUIRED");
        assertError(patchProvider(admin, "{\"provider\":\"libra\"}"),
                "TRANSLATION_PROVIDER_INVALID");

        mockMvc.perform(authed(patch("/api/v1/admin/plugins/translate"), admin)
                        .contentType(MediaType.APPLICATION_JSON).content("{}"))
                .andExpect(status().isBadRequest());

        SessionResponse user = devSession(uniqueDisplayName("translate-user"));
        mockMvc.perform(authed(get("/api/v1/admin/plugins/translate"), user))
                .andExpect(status().isForbidden());
    }

    @Test
    void storesRuntimeSettingsAndHealthReturnsStatusAndLatencyOnly() throws Exception {
        SessionResponse admin = adminSession();
        MvcResult updated = patchProvider(admin,
                "{\"enabled\":true,\"url\":\"" + PROVIDER_URL
                        + "\",\"provider\":\"LIBRETRANSLATE\"}");
        assertThat(updated.getResponse().getStatus()).isEqualTo(200);
        JsonNode settings = json(updated);
        CONTRACT.assertValid("TranslationProviderSettings", settings);
        assertThat(settings.get("enabled").asBoolean()).isTrue();
        assertThat(settings.get("url").asText()).isEqualTo(PROVIDER_URL);
        assertThat(settings.get("provider").asText()).isEqualTo("LIBRETRANSLATE");

        JsonNode read = json(mockMvc.perform(authed(
                        get("/api/v1/admin/plugins/translate"), admin))
                .andExpect(status().isOk()).andReturn());
        assertThat(read.get("url").asText()).isEqualTo(PROVIDER_URL);
        assertThat(migrator().queryForMap(
                "SELECT enabled, url, provider FROM ops.plugin_translation_settings"
                        + " WHERE id = 1"))
                .containsEntry("enabled", true).containsEntry("url", PROVIDER_URL)
                .containsEntry("provider", "LIBRETRANSLATE");

        MvcResult test = mockMvc.perform(authed(
                        post("/api/v1/admin/plugins/translate/test"), admin))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode health = json(test);
        CONTRACT.assertValid("TranslationProviderTest", health);
        assertThat(health.get("status").asText()).isIn("UNAVAILABLE", "OK");
        assertThat(health.get("latency_ms").asLong()).isBetween(0L, 60_000L);
        assertThat(test.getResponse().getContentAsString())
                .doesNotContain(PROVIDER_URL, "ping", "translated");

        String updateAudit = migrator().queryForObject("""
                SELECT metadata::text FROM audit.audit_events
                 WHERE action = 'admin.plugin.translate.updated'
                 ORDER BY created_at DESC LIMIT 1
                """, String.class);
        assertThat(updateAudit).contains("enabled", "url_changed", "provider",
                        "provider_changed", "LIBRETRANSLATE")
                .doesNotContain(PROVIDER_URL, "secret");
        String testAudit = migrator().queryForObject("""
                SELECT metadata::text FROM audit.audit_events
                 WHERE action = 'admin.plugin.translate.tested'
                 ORDER BY created_at DESC LIMIT 1
                """, String.class);
        assertThat(testAudit).contains("status", "latency_ms")
                .doesNotContain(PROVIDER_URL, "ping");

        int auditsBefore = migrator().queryForObject("""
                SELECT count(*) FROM audit.audit_events
                 WHERE action = 'admin.plugin.translate.updated'
                """, Integer.class);
        patchProvider(admin, "{\"enabled\":true,\"url\":\"" + PROVIDER_URL
                + "\",\"provider\":\"LIBRETRANSLATE\"}");
        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM audit.audit_events
                 WHERE action = 'admin.plugin.translate.updated'
                """, Integer.class)).isEqualTo(auditsBefore);

        JsonNode disabled = json(patchProvider(admin, "{\"enabled\":false}"));
        assertThat(disabled.get("enabled").asBoolean()).isFalse();
        assertThat(disabled.get("provider").asText()).isEqualTo("LIBRETRANSLATE");
        JsonNode disabledHealth = json(mockMvc.perform(authed(
                        post("/api/v1/admin/plugins/translate/test"), admin))
                .andExpect(status().isOk()).andReturn());
        CONTRACT.assertValid("TranslationProviderTest", disabledHealth);
        assertThat(disabledHealth.get("status").asText()).isEqualTo("DISABLED");
        assertThat(disabledHealth.get("latency_ms").asLong()).isZero();
    }

    @Test
    void acceptsAnInternalHttpLibreTranslateUrlOnly() throws Exception {
        SessionResponse admin = adminSession();
        MvcResult updated = patchProvider(admin,
                "{\"enabled\":true,\"url\":\"http://libretranslate:5000/translate\","
                        + "\"provider\":\"LIBRETRANSLATE\"}");
        assertThat(updated.getResponse().getStatus()).isEqualTo(200);
        JsonNode settings = json(updated);
        CONTRACT.assertValid("TranslationProviderSettings", settings);
        assertThat(settings.get("url").asText())
                .isEqualTo("http://libretranslate:5000/translate");
        assertThat(settings.get("provider").asText()).isEqualTo("LIBRETRANSLATE");

        assertError(patchProvider(admin,
                "{\"url\":\"http://translate.example.test/translate\"}"),
                "TRANSLATION_URL_INVALID");
        assertError(patchProvider(admin, "{\"url\":\"http://8.8.8.8:5000/translate\"}"),
                "TRANSLATION_URL_INVALID");
    }

    @Test
    void rejectsNonAdminPatchAndTest() throws Exception {
        SessionResponse user = devSession(uniqueDisplayName("translate-outsider"));
        mockMvc.perform(authed(patch("/api/v1/admin/plugins/translate"), user)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"enabled\":false}"))
                .andExpect(status().isForbidden());
        mockMvc.perform(authed(post("/api/v1/admin/plugins/translate/test"), user))
                .andExpect(status().isForbidden());
    }

    private MvcResult patchProvider(SessionResponse admin, String body) throws Exception {
        return mockMvc.perform(authed(patch("/api/v1/admin/plugins/translate"), admin)
                        .contentType(MediaType.APPLICATION_JSON).content(body))
                .andReturn();
    }

    private void assertError(MvcResult result, String code) throws Exception {
        assertThat(result.getResponse().getStatus()).isEqualTo(422);
        JsonNode error = json(result);
        CONTRACT.assertValid("Error", error);
        assertThat(error.get("code").asText()).isEqualTo(code);
    }

    private SessionResponse adminSession() throws Exception {
        SessionResponse session = devSession(uniqueDisplayName("translate-admin"));
        migrator().update("UPDATE auth.users SET is_platform_admin = false "
                + "WHERE is_platform_admin");
        migrator().update("UPDATE auth.users SET is_platform_admin = true WHERE id = ?",
                session.user().id());
        return session;
    }
}
