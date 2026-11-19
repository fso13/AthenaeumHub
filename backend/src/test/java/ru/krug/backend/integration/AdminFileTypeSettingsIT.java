package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MvcResult;

import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.shared.domain.model.AllowedFileExtensions;
import ru.krug.backend.support.FileUploadTestSupport;
import ru.krug.backend.support.OpenApiContract;

/**
 * Admin-managed {@code allowed_file_extensions}: GET/PATCH contract, strict validation,
 * immediate cache invalidation on PATCH, M4A acceptance and the non-weakenable dangerous
 * block. The setting is runtime-only: no restart is involved.
 */
@ActiveProfiles("test")
class AdminFileTypeSettingsIT extends FileUploadTestSupport {

    private static final OpenApiContract CONTRACT = OpenApiContract.load();

    private SessionResponse admin;

    @BeforeEach
    void setUp() throws Exception {
        admin = adminSession();
        patchAllowed(AllowedFileExtensions.defaults().values());
    }

    @AfterEach
    void tearDown() throws Exception {
        patchAllowed(AllowedFileExtensions.defaults().values());
    }

    @Test
    void getAndPatchExposeTheNormalizedAllowlistAndAuditOnlyFieldNames() throws Exception {
        JsonNode initial = settings();
        CONTRACT.assertValid("AdminSettings", initial);
        assertThat(initial.get("allowed_file_extensions"))
                .isEqualTo(objectMapper.valueToTree(AllowedFileExtensions.defaults().values()));
        assertThat(initial.get("allowed_file_extensions").toString()).contains("m4a");

        MvcResult patched = mockMvc.perform(authed(patch("/api/v1/admin/settings"), admin)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "allowed_file_extensions", List.of(" TXT ", "M4A")))))
                .andReturn();
        assertThat(patched.getResponse().getStatus())
                .as(patched.getResponse().getContentAsString()).isEqualTo(200);
        JsonNode body = json(patched);
        CONTRACT.assertValid("AdminSettings", body);
        assertThat(body.get("allowed_file_extensions").toString()).isEqualTo("[\"txt\",\"m4a\"]");

        assertThat(settings().get("allowed_file_extensions").toString())
                .isEqualTo("[\"txt\",\"m4a\"]");

        String metadata = migrator().queryForObject("""
                SELECT metadata::text FROM audit.audit_events
                 WHERE actor_id = ? AND action = 'settings.updated'
                 ORDER BY seq DESC LIMIT 1
                """, String.class, admin.user().id());
        assertThat(metadata).contains("allowed_file_extensions");
        // settings.updated carries field names only; the allowlist values are not copied.
        assertThat(metadata).doesNotContain("\"txt\"").doesNotContain("\"m4a\"");
    }

    @Test
    void invalidAllowlistsAreRejectedWithoutChangingTheStoredSetting() throws Exception {
        List<List<String>> invalid = new ArrayList<>();
        invalid.add(List.of());
        invalid.add(List.of(".jpg"));
        invalid.add(List.of("j pg"));
        invalid.add(List.of("abcdefghijk"));
        invalid.add(List.of("jpg", "JPG"));
        invalid.add(List.of("exe"));
        invalid.add(List.of("bat"));
        invalid.add(List.of("html"));
        invalid.add(List.of("svg"));
        invalid.add(List.of(""));
        List<String> tooMany = new ArrayList<>();
        for (int i = 0; i <= AllowedFileExtensions.MAX_ENTRIES; i++) {
            tooMany.add("x" + i);
        }
        invalid.add(tooMany);

        for (List<String> extensions : invalid) {
            MvcResult result = mockMvc.perform(authed(patch("/api/v1/admin/settings"), admin)
                            .contentType(MediaType.APPLICATION_JSON)
                            .content(objectMapper.writeValueAsString(
                                    Map.of("allowed_file_extensions", extensions))))
                    .andReturn();
            assertThat(result.getResponse().getStatus())
                    .as("input %s: %s", extensions, result.getResponse().getContentAsString())
                    .isEqualTo(400);
            assertThat(json(result).get("code").asText()).isEqualTo("VALIDATION_FAILED");
        }

        assertThat(settings().get("allowed_file_extensions"))
                .isEqualTo(objectMapper.valueToTree(AllowedFileExtensions.defaults().values()));
    }

    @Test
    void patchInvalidatesTheCacheImmediatelyAndUnlistedExtensionsBecome415() throws Exception {
        UUID chatId = admin.chat().id();
        byte[] data = randomBytes(64);

        // Warm the cache with the default list: png is allowed.
        assertThat(init(admin, chatId, "warm.png", data, "image/png")
                .getResponse().getStatus()).isEqualTo(201);

        patchAllowed(List.of("txt", "m4a"));

        MvcResult png = init(admin, chatId, "after-patch.png", data, "image/png");
        assertThat(png.getResponse().getStatus())
                .as(png.getResponse().getContentAsString()).isEqualTo(415);
        JsonNode error = json(png);
        assertThat(error.get("code").asText()).isEqualTo("UNSUPPORTED_TYPE");
        assertThat(error.at("/details/extension").asText()).isEqualTo("png");
        assertThat(error.at("/details/allowed").isArray()).isTrue();

        assertThat(init(admin, chatId, "after-patch.txt", data, "text/plain")
                .getResponse().getStatus()).isEqualTo(201);
        assertThat(init(admin, chatId, "interview.m4a", data, "audio/mp4")
                .getResponse().getStatus()).isEqualTo(201);
        assertThat(init(admin, chatId, "interview-x.m4a", data, "audio/x-m4a")
                .getResponse().getStatus()).isEqualTo(201);

        JsonNode preflight = json(preflight(admin, chatId,
                List.of(file("interview.m4a", data.length, "audio/mp4"))));
        assertThat(preflight.get("files").get(0).get("allowed").asBoolean()).isTrue();
    }

    @Test
    void dangerousExtensionsAreBlockedOnUploadAndCannotBeConfigured() throws Exception {
        MvcResult configured = mockMvc.perform(authed(patch("/api/v1/admin/settings"), admin)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"allowed_file_extensions\":[\"exe\"]}"))
                .andReturn();
        assertThat(configured.getResponse().getStatus()).isEqualTo(400);

        // DB backstop: even a direct SQL write cannot allowlist an executable extension.
        assertThatThrownBy(() -> migrator().update(
                "UPDATE ops.system_settings SET allowed_file_extensions = ARRAY['exe'] "
                        + "WHERE id = 1"))
                .isInstanceOf(DataIntegrityViolationException.class);

        UUID chatId = admin.chat().id();
        byte[] data = randomBytes(32);
        MvcResult exe = init(admin, chatId, "payload.exe", data, "application/octet-stream");
        assertThat(exe.getResponse().getStatus()).isEqualTo(422);
        assertThat(json(exe).get("code").asText()).isEqualTo("DANGEROUS_TYPE_BLOCKED");

        MvcResult svg = init(admin, chatId, "payload.svg", data, "image/svg+xml");
        assertThat(svg.getResponse().getStatus()).isEqualTo(422);
        assertThat(json(svg).get("code").asText()).isEqualTo("DANGEROUS_TYPE_BLOCKED");

        JsonNode preflight = json(preflight(admin, chatId,
                List.of(file("payload.exe", data.length, "application/octet-stream"))));
        assertThat(preflight.get("files").get(0).get("error").asText())
                .isEqualTo("DANGEROUS_TYPE_BLOCKED");
    }

    private JsonNode settings() throws Exception {
        MvcResult result = mockMvc.perform(authed(get("/api/v1/admin/settings"), admin))
                .andReturn();
        assertThat(result.getResponse().getStatus())
                .as(result.getResponse().getContentAsString()).isEqualTo(200);
        return json(result);
    }

    private void patchAllowed(List<String> extensions) throws Exception {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("allowed_file_extensions", extensions);
        MvcResult result = mockMvc.perform(authed(patch("/api/v1/admin/settings"), admin)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(body)))
                .andReturn();
        assertThat(result.getResponse().getStatus())
                .as(result.getResponse().getContentAsString()).isEqualTo(200);
    }

    private SessionResponse adminSession() throws Exception {
        SessionResponse session = devSession(uniqueDisplayName("filetypes-admin"));
        migrator().update("UPDATE auth.users SET is_platform_admin = false "
                + "WHERE is_platform_admin");
        migrator().update("UPDATE auth.users SET is_platform_admin = true WHERE id = ?",
                session.user().id());
        return session;
    }
}
