package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;

import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.support.IntegrationTestBase;
import ru.krug.backend.support.OpenApiContract;

/**
 * #84: the historical environment URL remains the fallback until an administrator saves an
 * explicit setting; an explicit disable then wins over the environment.
 */
@SpringBootTest(properties = {
        "krug.plugins.translate.url=https://env.example.test/v1/translate",
        "krug.plugins.translate.provider=libretranslate"})
@ActiveProfiles("test")
class TranslationEnvFallbackIT extends IntegrationTestBase {

    private static final OpenApiContract CONTRACT = OpenApiContract.load();
    private static final String ENV_URL = "https://env.example.test/v1/translate";

    @BeforeEach
    void resetSettings() {
        migrator().update("DELETE FROM ops.plugin_translation_settings");
    }

    @Test
    void environmentFallbackAppliesUntilAnExplicitSettingExists() throws Exception {
        SessionResponse admin = adminSession();
        JsonNode defaults = json(mockMvc.perform(authed(
                        get("/api/v1/admin/plugins/translate"), admin))
                .andExpect(status().isOk()).andReturn());
        CONTRACT.assertValid("TranslationProviderSettings", defaults);
        assertThat(defaults.get("enabled").asBoolean()).isTrue();
        assertThat(defaults.get("url").asText()).isEqualTo(ENV_URL);
        assertThat(defaults.get("provider").asText()).isEqualTo("LIBRETRANSLATE");

        JsonNode disabled = json(mockMvc.perform(authed(
                        patch("/api/v1/admin/plugins/translate"), admin)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"enabled\":false}"))
                .andExpect(status().isOk()).andReturn());
        assertThat(disabled.get("enabled").asBoolean()).isFalse();
        assertThat(disabled.get("url").asText()).isEmpty();
        assertThat(disabled.get("provider").asText()).isEqualTo("AUTO");

        JsonNode reenabled = json(mockMvc.perform(authed(
                        patch("/api/v1/admin/plugins/translate"), admin)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"enabled\":true}"))
                .andExpect(status().isOk()).andReturn());
        assertThat(reenabled.get("enabled").asBoolean()).isTrue();
        assertThat(reenabled.get("url").asText()).isEqualTo(ENV_URL);
        assertThat(reenabled.get("provider").asText()).isEqualTo("LIBRETRANSLATE");
    }

    private SessionResponse adminSession() throws Exception {
        SessionResponse session = devSession(uniqueDisplayName("env-admin"));
        migrator().update("UPDATE auth.users SET is_platform_admin = false "
                + "WHERE is_platform_admin");
        migrator().update("UPDATE auth.users SET is_platform_admin = true WHERE id = ?",
                session.user().id());
        return session;
    }
}
