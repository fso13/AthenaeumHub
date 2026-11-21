package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.DataAccessException;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MvcResult;

import ru.krug.backend.file.application.port.ObjectStoragePort;
import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.plugin.application.usecase.GetPluginAssetService;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.support.IntegrationTestBase;
import ru.krug.backend.support.OpenApiContract;
import ru.krug.backend.support.PluginPackageTestSupport;

/**
 * D1.2 (#86) end-to-end: admin-only ZIP install, safe archive validation, catalog
 * visibility, authenticated asset serving, uninstall, audit and the catalog RLS split.
 */
@ActiveProfiles("test")
class PluginPackagesIT extends IntegrationTestBase {

    private static final OpenApiContract CONTRACT = OpenApiContract.load();
    private static final String PLUGIN_ID = "demo-panel";

    @Autowired
    private ObjectStoragePort objectStorage;

    @Autowired
    private GetPluginAssetService getPluginAsset;

    @BeforeEach
    @AfterEach
    void resetPackages() {
        migrator().update("""
                DELETE FROM chat.chat_plugins
                 WHERE plugin_id IN (SELECT id FROM plugin.catalog WHERE kind = 'EXTERNAL')
                """);
        migrator().update("DELETE FROM plugin.package_objects");
        migrator().update("DELETE FROM plugin.packages");
        migrator().update("DELETE FROM plugin.catalog WHERE kind = 'EXTERNAL'");
    }

    @Test
    void installsPackageServesAssetsListsCatalogAndEnablesInChat() throws Exception {
        SessionResponse admin = adminSession();

        MvcResult uploaded = install(admin, validZip());
        assertThat(uploaded.getResponse().getStatus()).isEqualTo(201);
        JsonNode body = json(uploaded);
        CONTRACT.assertValid("AdminPluginPackage", body);
        assertThat(body.get("id").asText()).isEqualTo(PLUGIN_ID);
        assertThat(body.get("version").asText()).isEqualTo("1.2.3");
        assertThat(body.get("author").asText()).isEqualTo("Sova");
        assertThat(body.get("entry").asText()).isEqualTo("index.html");
        assertThat(body.get("permissions").get(0).asText()).isEqualTo("chat.messages.read");
        assertThat(body.get("file_count").asInt()).isEqualTo(3);
        assertThat(body.get("size_bytes").asLong()).isGreaterThan(0);
        assertThat(body.get("sha256").asText()).matches("[0-9a-f]{64}");

        Map<String, Object> catalog = migrator().queryForMap("""
                SELECT kind, install_state, state, version, author, entry
                  FROM plugin.catalog WHERE id = ?
                """, PLUGIN_ID);
        assertThat(catalog.get("kind")).isEqualTo("EXTERNAL");
        assertThat(catalog.get("install_state")).isEqualTo("INSTALLED");
        assertThat(catalog.get("state")).isEqualTo("ACTIVE");
        assertThat(catalog.get("version")).isEqualTo("1.2.3");
        assertThat(catalog.get("author")).isEqualTo("Sova");
        assertThat(catalog.get("entry")).isEqualTo("index.html");
        assertThat(migrator().queryForObject(
                "SELECT count(*) FROM plugin.packages WHERE plugin_id = ?",
                Long.class, PLUGIN_ID)).isEqualTo(1L);
        assertThat(migrator().queryForObject(
                "SELECT count(*) FROM plugin.package_objects WHERE plugin_id = ?",
                Long.class, PLUGIN_ID)).isEqualTo(3L);

        MvcResult listed = mockMvc.perform(authed(get("/api/v1/admin/plugins"), admin))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode list = json(listed);
        CONTRACT.assertValid("AdminPluginPackageList", list);
        assertThat(list.get("items")).hasSize(1);
        assertThat(list.get("items").get(0).get("id").asText()).isEqualTo(PLUGIN_ID);

        JsonNode catalogList = json(mockMvc.perform(authed(get("/api/v1/plugins"), admin))
                .andExpect(status().isOk()).andReturn());
        CONTRACT.assertValid("PluginList", catalogList);
        // Six built-ins (including music-room) plus the freshly installed external package.
        assertThat(catalogList.get("items")).hasSize(7);
        JsonNode external = item(catalogList, PLUGIN_ID);
        CONTRACT.assertValid("Plugin", external);
        assertThat(external.get("kind").asText()).isEqualTo("EXTERNAL");
        assertThat(external.get("version").asText()).isEqualTo("1.2.3");
        assertThat(external.get("author").asText()).isEqualTo("Sova");
        assertThat(external.get("entry_url").asText())
                .isEqualTo("/api/v1/plugins/demo-panel/assets/index.html");
        JsonNode builtin = item(catalogList, "polls");
        assertThat(builtin.get("kind").asText()).isEqualTo("BUILTIN");
        assertThat(builtin.has("version")).isFalse();
        assertThat(builtin.has("entry_url")).isFalse();

        MvcResult html = mockMvc.perform(authed(get(
                        "/api/v1/plugins/{pluginId}/assets/index.html", PLUGIN_ID), admin))
                .andExpect(status().isOk())
                .andReturn();
        assertThat(html.getResponse().getContentType()).startsWith("text/html");
        assertThat(html.getResponse().getContentAsString()).contains("ok");
        assertThat(html.getResponse().getHeader("X-Content-Type-Options")).isEqualTo("nosniff");
        assertThat(html.getResponse().getHeader("Content-Security-Policy"))
                .contains("sandbox allow-scripts", "connect-src 'none'",
                        "frame-ancestors 'self'");
        assertThat(html.getResponse().getHeader("Content-Disposition"))
                .startsWith("inline");
        // The sandboxed plugin iframe is the one deliberate frame exception; every
        // other API response keeps the default clickjacking protection.
        assertThat(html.getResponse().getHeader("X-Frame-Options")).isNull();
        assertThat(listed.getResponse().getHeader("X-Frame-Options")).isEqualTo("DENY");

        MvcResult js = mockMvc.perform(authed(get(
                        "/api/v1/plugins/{pluginId}/assets/assets/app.js", PLUGIN_ID), admin))
                .andExpect(status().isOk())
                .andReturn();
        assertThat(js.getResponse().getContentType()).startsWith("text/javascript");
        assertThat(js.getResponse().getHeader("Content-Security-Policy"))
                .doesNotContain("sandbox allow-scripts");

        mockMvc.perform(get("/api/v1/plugins/{pluginId}/assets/index.html", PLUGIN_ID))
                .andExpect(status().isUnauthorized());

        // The existing per-chat toggle works for an external package without changes.
        MvcResult toggled = mockMvc.perform(authed(patch(
                        "/api/v1/chats/{chatId}/plugins/{pluginId}", admin.chat().id(), PLUGIN_ID),
                        admin)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"enabled\":true}"))
                .andExpect(status().isOk())
                .andReturn();
        assertThat(json(toggled).get("enabled").asBoolean()).isTrue();
        JsonNode states = json(mockMvc.perform(authed(get(
                        "/api/v1/chats/{chatId}/plugins", admin.chat().id()), admin))
                .andExpect(status().isOk()).andReturn());
        assertThat(stateIds(states)).contains(PLUGIN_ID);

        String metadata = migrator().queryForObject("""
                SELECT string_agg(metadata::text, ' ')
                  FROM audit.audit_events WHERE action = 'admin.plugin.installed'
                """, String.class);
        assertThat(metadata).contains(PLUGIN_ID, "1.2.3", "file_count");
        assertThat(metadata).doesNotContain("demo body", "<html", "console.log");
    }

    @Test
    void uninstallHidesPackageDeletesMetadataAndKeepsCatalogTombstone() throws Exception {
        SessionResponse admin = adminSession();
        assertThat(install(admin, validZip()).getResponse().getStatus()).isEqualTo(201);
        List<String> objectKeys = migrator().queryForList(
                "SELECT object_key FROM plugin.package_objects WHERE plugin_id = ?",
                String.class, PLUGIN_ID);
        assertThat(objectKeys).hasSize(3);
        assertThat(objectKeys).allMatch(objectStorage::exists);

        mockMvc.perform(authed(delete("/api/v1/admin/plugins/{pluginId}", PLUGIN_ID), admin))
                .andExpect(status().isNoContent());

        assertThat(migrator().queryForObject(
                "SELECT count(*) FROM plugin.packages WHERE plugin_id = ?",
                Long.class, PLUGIN_ID)).isZero();
        assertThat(migrator().queryForObject(
                "SELECT count(*) FROM plugin.package_objects WHERE plugin_id = ?",
                Long.class, PLUGIN_ID)).isZero();
        Map<String, Object> catalog = migrator().queryForMap("""
                SELECT kind, install_state, state FROM plugin.catalog WHERE id = ?
                """, PLUGIN_ID);
        assertThat(catalog.get("install_state")).isEqualTo("UNINSTALLED");
        assertThat(catalog.get("state")).isEqualTo("DISABLED");
        assertThat(objectKeys).noneMatch(objectStorage::exists);

        assertThat(json(mockMvc.perform(authed(get("/api/v1/admin/plugins"), admin))
                .andExpect(status().isOk()).andReturn()).get("items")).isEmpty();
        JsonNode catalogList = json(mockMvc.perform(authed(get("/api/v1/plugins"), admin))
                .andExpect(status().isOk()).andReturn());
        assertThat(catalogList.get("items")).hasSize(6);
        assertThat(ids(catalogList)).doesNotContain(PLUGIN_ID);

        mockMvc.perform(authed(get(
                        "/api/v1/plugins/{pluginId}/assets/index.html", PLUGIN_ID), admin))
                .andExpect(status().isNotFound());
        mockMvc.perform(authed(delete("/api/v1/admin/plugins/{pluginId}", PLUGIN_ID), admin))
                .andExpect(status().isNotFound());

        // A reinstall reuses the tombstone row and becomes visible again.
        assertThat(install(admin, validZip()).getResponse().getStatus()).isEqualTo(201);
        assertThat(ids(json(mockMvc.perform(authed(get("/api/v1/plugins"), admin))
                .andExpect(status().isOk()).andReturn()))).contains(PLUGIN_ID);
    }

    @Test
    void rejectsUnsafeArchivesManifestsAndOversizedUploads() throws Exception {
        SessionResponse admin = adminSession();

        assertInvalid(admin, traversalZip(), "PLUGIN_PACKAGE_INVALID");
        assertInvalid(admin, PluginPackageTestSupport.zipWithSymlink(
                PluginPackageTestSupport.DEFAULT_MANIFEST, "index.html"),
                "PLUGIN_PACKAGE_INVALID");
        assertInvalid(admin, PluginPackageTestSupport.zipBomb(
                PluginPackageTestSupport.DEFAULT_MANIFEST, "index.html"),
                "PLUGIN_PACKAGE_INVALID");
        assertInvalid(admin, PluginPackageTestSupport.manyFiles(
                PluginPackageTestSupport.manifest("many-files", "index.html", "[]",
                        "[\"MANAGED\"]"), "index.html", 200), "PLUGIN_PACKAGE_INVALID");
        assertInvalid(admin, PluginPackageTestSupport.zipWithText("{not json",
                "index.html", Map.of()), "PLUGIN_PACKAGE_INVALID");
        assertInvalid(admin, PluginPackageTestSupport.zipWithText(
                PluginPackageTestSupport.manifest("bad-entry", "missing.html", "[]",
                        "[\"MANAGED\"]"), "index.html", Map.of()),
                "PLUGIN_PACKAGE_INVALID");
        assertInvalid(admin, PluginPackageTestSupport.zipWithText(
                PluginPackageTestSupport.manifest("bad-permission", "index.html",
                        "[\"chat.secrets.read\"]", "[\"MANAGED\"]"),
                "index.html", Map.of()), "PLUGIN_PACKAGE_INVALID");

        MvcResult missingPart = mockMvc.perform(authed(
                        multipart("/api/v1/admin/plugins"), admin))
                .andReturn();
        assertThat(missingPart.getResponse().getStatus()).isEqualTo(400);
        CONTRACT.assertValid("Error", json(missingPart));

        byte[] oversized = new byte[5 * 1024 * 1024 + 1];
        MvcResult tooLarge = install(admin, oversized);
        assertThat(tooLarge.getResponse().getStatus()).isEqualTo(413);
        JsonNode error = json(tooLarge);
        CONTRACT.assertValid("Error", error);
        assertThat(error.get("code").asText()).isEqualTo("PLUGIN_PACKAGE_TOO_LARGE");

        assertThat(migrator().queryForObject(
                "SELECT count(*) FROM plugin.packages", Long.class)).isZero();
        assertThat(migrator().queryForObject(
                "SELECT count(*) FROM plugin.catalog WHERE kind = 'EXTERNAL'",
                Long.class)).isZero();
    }

    @Test
    void installationIsAdminOnlyAndConflictsAreStable() throws Exception {
        SessionResponse member = devSession(uniqueDisplayName("plugin-member"));
        MvcResult forbidden = install(member, validZip());
        assertThat(forbidden.getResponse().getStatus()).isEqualTo(403);
        assertThat(json(forbidden).get("code").asText()).isEqualTo("FORBIDDEN");
        mockMvc.perform(authed(get("/api/v1/admin/plugins"), member))
                .andExpect(status().isForbidden());
        mockMvc.perform(authed(delete("/api/v1/admin/plugins/{pluginId}", PLUGIN_ID), member))
                .andExpect(status().isForbidden());

        SessionResponse admin = adminSession();
        assertThat(install(admin, validZip()).getResponse().getStatus()).isEqualTo(201);

        MvcResult duplicate = install(admin, validZip());
        assertThat(duplicate.getResponse().getStatus()).isEqualTo(409);
        assertThat(json(duplicate).get("code").asText())
                .isEqualTo("PLUGIN_ALREADY_INSTALLED");

        byte[] builtinId = PluginPackageTestSupport.zipWithText(
                PluginPackageTestSupport.manifest("polls", "index.html", "[]",
                        "[\"MANAGED\"]"), "index.html", Map.of());
        MvcResult reserved = install(admin, builtinId);
        assertThat(reserved.getResponse().getStatus()).isEqualTo(409);
        assertThat(json(reserved).get("code").asText()).isEqualTo("PLUGIN_ID_RESERVED");
        assertThat(migrator().queryForObject(
                "SELECT version FROM plugin.catalog WHERE id = 'polls'", String.class)).isNull();
    }

    @Test
    void assetServiceRejectsTraversalAndUnknownPaths() throws Exception {
        SessionResponse admin = adminSession();
        assertThat(install(admin, validZip()).getResponse().getStatus()).isEqualTo(201);

        assertThatThrownBy(() -> getPluginAsset.get(PLUGIN_ID, "../manifest.json"))
                .isInstanceOf(DomainException.class);
        assertThatThrownBy(() -> getPluginAsset.get(PLUGIN_ID, "/assets/../../etc/passwd"))
                .isInstanceOf(DomainException.class);
        assertThatThrownBy(() -> getPluginAsset.get(PLUGIN_ID, "assets//app.js"))
                .isInstanceOf(DomainException.class);

        mockMvc.perform(authed(get(
                        "/api/v1/plugins/{pluginId}/assets/assets/missing.js", PLUGIN_ID), admin))
                .andExpect(status().isNotFound());
        mockMvc.perform(authed(get(
                        "/api/v1/plugins/{pluginId}/assets/index.html", "unknown-plugin"), admin))
                .andExpect(status().isNotFound());
    }

    @Test
    void catalogWriteRlsIsExternalOnlyAndSchemaHasNoExecutionFunctions() {
        assertThat(jdbc.queryForObject("""
                SELECT relrowsecurity FROM pg_class WHERE oid = 'plugin.catalog'::regclass
                """, Boolean.class)).isTrue();
        assertThat(jdbc.queryForObject("""
                SELECT relforcerowsecurity FROM pg_class WHERE oid = 'plugin.catalog'::regclass
                """, Boolean.class)).isFalse();
        assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM pg_policies
                 WHERE schemaname = 'plugin' AND tablename = 'catalog'
                """, Long.class)).isEqualTo(4L);

        for (String privilege : List.of("SELECT", "INSERT", "UPDATE", "DELETE")) {
            assertThat(jdbc.queryForObject(
                    "SELECT has_table_privilege('krug_app', 'plugin.catalog', ?)",
                    Boolean.class, privilege)).as(privilege).isTrue();
        }
        for (String table : List.of("plugin.packages", "plugin.package_objects")) {
            for (String privilege : List.of("SELECT", "INSERT", "UPDATE", "DELETE")) {
                assertThat(jdbc.queryForObject(
                        "SELECT has_table_privilege('krug_app', ?, ?)",
                        Boolean.class, table, privilege)).as(table + " " + privilege).isTrue();
            }
        }

        // The application role cannot update or delete a built-in catalog row...
        assertThat(jdbc.update("UPDATE plugin.catalog SET name = 'hacked' WHERE id = 'polls'"))
                .isZero();
        assertThat(jdbc.update("DELETE FROM plugin.catalog WHERE id = 'polls'")).isZero();
        assertThat(jdbc.queryForObject(
                "SELECT name FROM plugin.catalog WHERE id = 'polls'", String.class))
                .isEqualTo("Опросы");
        // ...and cannot insert a row that pretends to be built-in.
        assertThatThrownBy(() -> jdbc.update("""
                INSERT INTO plugin.catalog (id, name, description, modes, kind)
                VALUES ('fake-builtin', 'Fake', 'Fake', ARRAY['MANAGED']::text[], 'BUILTIN')
                """)).isInstanceOf(DataAccessException.class);

        assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM pg_proc p
                  JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'plugin'
                """, Long.class)).isZero();
        assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM pg_constraint
                 WHERE conrelid = 'plugin.packages'::regclass AND contype = 'p'
                """, Long.class)).isEqualTo(1L);
        assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM pg_constraint
                 WHERE conrelid = 'plugin.package_objects'::regclass AND contype = 'p'
                """, Long.class)).isEqualTo(1L);
    }

    // ------------------------------------------------------------------

    private MvcResult install(SessionResponse actor, byte[] archive) throws Exception {
        MockMultipartFile file = new MockMultipartFile("file", "plugin.zip",
                "application/zip", archive);
        return mockMvc.perform(authed(multipart("/api/v1/admin/plugins").file(file), actor))
                .andReturn();
    }

    private void assertInvalid(SessionResponse actor, byte[] archive, String code)
            throws Exception {
        MvcResult result = install(actor, archive);
        assertThat(result.getResponse().getStatus()).isEqualTo(400);
        JsonNode error = json(result);
        CONTRACT.assertValid("Error", error);
        assertThat(error.get("code").asText()).isEqualTo(code);
    }

    private static byte[] validZip() {
        return PluginPackageTestSupport.zipWithText(
                PluginPackageTestSupport.manifest(PLUGIN_ID, "index.html",
                        "[\"chat.messages.read\", \"chat.members.read\"]",
                        "[\"MANAGED\"]"),
                "index.html",
                Map.of("assets/app.js", "console.log('demo')",
                        "assets/logo.svg", "<svg xmlns=\"http://www.w3.org/2000/svg\"/>"));
    }

    private static byte[] traversalZip() {
        Map<String, byte[]> entries = new LinkedHashMap<>();
        entries.put("manifest.json", PluginPackageTestSupport.manifest(PLUGIN_ID, "index.html",
                "[]", "[\"MANAGED\"]").getBytes(StandardCharsets.UTF_8));
        entries.put("index.html", "<html/>".getBytes(StandardCharsets.UTF_8));
        entries.put("../evil.html", "<html/>".getBytes(StandardCharsets.UTF_8));
        return PluginPackageTestSupport.zip(entries);
    }

    private SessionResponse adminSession() throws Exception {
        SessionResponse session = devSession(uniqueDisplayName("plugin-admin"));
        migrator().update("UPDATE auth.users SET is_platform_admin = false "
                + "WHERE is_platform_admin");
        migrator().update("UPDATE auth.users SET is_platform_admin = true WHERE id = ?",
                session.user().id());
        return session;
    }

    private static JsonNode item(JsonNode body, String id) {
        for (JsonNode node : body.get("items")) {
            if (id.equals(node.get("id").asText())) {
                return node;
            }
        }
        throw new AssertionError("plugin not found: " + id);
    }

    private static List<String> ids(JsonNode body) {
        return java.util.stream.StreamSupport.stream(body.get("items").spliterator(), false)
                .map(node -> node.get("id").asText())
                .toList();
    }

    private static List<String> stateIds(JsonNode body) {
        return java.util.stream.StreamSupport.stream(body.get("items").spliterator(), false)
                .map(node -> node.get("plugin_id").asText())
                .toList();
    }
}
