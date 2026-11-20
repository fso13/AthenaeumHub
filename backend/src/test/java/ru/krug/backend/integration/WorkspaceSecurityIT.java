package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MvcResult;

import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.support.IntegrationTestBase;
import ru.krug.backend.support.OpenApiContract;

/**
 * P0-3 (#81): workspace DLP policies/events, workspace audit page/export, security
 * settings and the manager-only permission surface.
 *
 * <p>Runs against the real REST/DB/audit stack in the dev profile. Keycloak-backed session
 * success/current/foreign/503 behaviour is covered by {@code WorkspaceSessionsIT}; this
 * class covers the dev-workspace empty/ownership/permission paths.</p>
 */
@ActiveProfiles("test")
class WorkspaceSecurityIT extends IntegrationTestBase {

    private static final OpenApiContract CONTRACT = OpenApiContract.load();

    @AfterEach
    void removeBulkAuditFixtures() {
        migrator().update("DELETE FROM audit.audit_events WHERE action = 'test.bulk'");
    }

    @Test
    void dlpBlocksAndWarnsWithoutPersistingContent() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("dlp-enforce-owner"));
        UUID workspaceId = owner.workspace().id();
        mockMvc.perform(authed(patch("/api/v1/workspaces/{id}/security", workspaceId), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("dlp_enabled", true))))
                .andExpect(status().isOk());
        createDlpPolicy(owner, workspaceId, "Block secrets", "BLOCK", "KEYWORD",
                "top-secret");
        createDlpPolicy(owner, workspaceId, "Warn cards", "WARN", "KEYWORD",
                "card-number");

        String blockedText = "here is a top-secret value";
        MvcResult blocked = mockMvc.perform(authed(
                        post("/api/v1/chats/{chatId}/messages", owner.chat().id()), owner)
                        .header("Idempotency-Key", UUID.randomUUID().toString())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(messageBody(UUID.randomUUID().toString(), blockedText, null)))
                .andExpect(status().isUnprocessableEntity())
                .andReturn();
        assertThat(json(blocked).get("code").asText()).isEqualTo("DLP_BLOCKED");
        CONTRACT.assertValid("Error", json(blocked));
        assertThat(messageCount(owner.chat().id())).isZero();

        String warnedText = "the card-number is present";
        mockMvc.perform(authed(post("/api/v1/chats/{chatId}/messages", owner.chat().id()),
                        owner)
                        .header("Idempotency-Key", UUID.randomUUID().toString())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(messageBody(UUID.randomUUID().toString(), warnedText, null)))
                .andExpect(status().isCreated());
        assertThat(messageCount(owner.chat().id())).isEqualTo(1);

        MvcResult events = mockMvc.perform(authed(
                        get("/api/v1/workspaces/{id}/dlp/events", workspaceId)
                                .param("limit", "10"), owner))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode eventBody = json(events);
        CONTRACT.assertValid("DlpEventPage", eventBody);
        assertThat(eventBody.get("items")).hasSize(2);
        assertThat(eventBody.get("items")).extracting(node -> node.get("action").asText())
                .containsExactlyInAnyOrder("BLOCK", "WARN");
        assertThat(eventBody.get("items")).extracting(node -> node.get("policy_name").asText())
                .contains("Block secrets", "Warn cards");

        String raw = events.getResponse().getContentAsString();
        assertThat(raw).doesNotContain(blockedText, warnedText, "top-secret", "card-number");
        String eventRows = migrator().queryForObject("""
                SELECT coalesce(string_agg(row_to_json(e)::text, ' '), '')
                  FROM workspace.dlp_events e WHERE e.workspace_id = ?
                """, String.class, workspaceId);
        assertThat(eventRows).doesNotContain(blockedText, warnedText, "top-secret",
                "card-number");
    }

    @Test
    void dlpCrudValidationAndAuditMinimisation() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("dlp-owner"));
        UUID workspaceId = owner.workspace().id();

        MvcResult created = mockMvc.perform(authed(
                        post("/api/v1/workspaces/{id}/dlp/policies", workspaceId), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(dlpBody("PII keyword", "WARN", "KEYWORD", "secret", true)))
                .andExpect(status().isCreated())
                .andReturn();
        JsonNode policy = json(created);
        CONTRACT.assertValid("DlpPolicy", policy);
        UUID policyId = UUID.fromString(policy.get("id").asText());
        assertThat(policy.get("name").asText()).isEqualTo("PII keyword");
        assertThat(policy.get("action").asText()).isEqualTo("WARN");
        assertThat(policy.get("pattern_type").asText()).isEqualTo("KEYWORD");
        assertThat(policy.get("enabled").asBoolean()).isTrue();

        MvcResult list = mockMvc.perform(authed(
                        get("/api/v1/workspaces/{id}/dlp/policies", workspaceId), owner))
                .andExpect(status().isOk())
                .andReturn();
        CONTRACT.assertValid("DlpPolicyList", json(list));
        assertThat(json(list).get("items")).hasSize(1);

        // Name uniqueness is case-insensitive.
        MvcResult duplicate = mockMvc.perform(authed(
                        post("/api/v1/workspaces/{id}/dlp/policies", workspaceId), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(dlpBody("pii KEYWORD", "BLOCK", "KEYWORD", "other", true)))
                .andExpect(status().isConflict())
                .andReturn();
        assertThat(json(duplicate).get("code").asText()).isEqualTo("DLP_POLICY_NAME_TAKEN");
        CONTRACT.assertValid("Error", json(duplicate));

        assertBadDlp(owner, workspaceId, dlpBody("bad-action", "ALERT", "KEYWORD", "x", true));
        assertBadDlp(owner, workspaceId, dlpBody("bad-type", "WARN", "REGEX", "x", true));
        assertBadDlp(owner, workspaceId,
                dlpBody("too-many-wildcards", "WARN", "PATTERN", "*".repeat(21), true));
        assertBadDlp(owner, workspaceId,
                dlpBody("control", "WARN", "KEYWORD", "line\nbreak", true));

        MvcResult updated = mockMvc.perform(authed(
                        patch("/api/v1/workspaces/{id}/dlp/policies/{policyId}", workspaceId,
                                policyId), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "name", "PII blocked",
                                "action", "BLOCK",
                                "enabled", false))))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode updatedPolicy = json(updated);
        CONTRACT.assertValid("DlpPolicy", updatedPolicy);
        assertThat(updatedPolicy.get("name").asText()).isEqualTo("PII blocked");
        assertThat(updatedPolicy.get("action").asText()).isEqualTo("BLOCK");
        assertThat(updatedPolicy.get("enabled").asBoolean()).isFalse();

        // Repeating the same values is idempotent and does not add a second audit event.
        mockMvc.perform(authed(patch("/api/v1/workspaces/{id}/dlp/policies/{policyId}",
                                workspaceId, policyId), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "name", "PII blocked", "action", "BLOCK", "enabled", false))))
                .andExpect(status().isOk());
        assertThat(auditCount(workspaceId, "workspace.dlp.policy.updated", policyId))
                .isEqualTo(1L);

        MvcResult emptyPatch = mockMvc.perform(authed(
                        patch("/api/v1/workspaces/{id}/dlp/policies/{policyId}", workspaceId,
                                policyId), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{}"))
                .andExpect(status().isBadRequest())
                .andReturn();
        assertThat(json(emptyPatch).get("code").asText()).isEqualTo("VALIDATION_FAILED");

        mockMvc.perform(authed(patch("/api/v1/workspaces/{id}/dlp/policies/{policyId}",
                                workspaceId, UUID.randomUUID()), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("enabled", true))))
                .andExpect(status().isNotFound());

        MvcResult deleted = mockMvc.perform(authed(
                        delete("/api/v1/workspaces/{id}/dlp/policies/{policyId}", workspaceId,
                                policyId), owner))
                .andExpect(status().isNoContent())
                .andReturn();
        assertThat(deleted.getResponse().getContentAsString()).isEmpty();
        mockMvc.perform(authed(delete("/api/v1/workspaces/{id}/dlp/policies/{policyId}",
                                workspaceId, policyId), owner))
                .andExpect(status().isNotFound());

        // The audit chain never receives the pattern text.
        String createMetadata = migrator().queryForObject("""
                SELECT metadata::text FROM audit.audit_events
                 WHERE action = 'workspace.dlp.policy.created' AND target_id = ?
                 ORDER BY created_at DESC LIMIT 1
                """, String.class, policyId);
        assertThat(createMetadata).contains("pattern_type", "KEYWORD")
                .doesNotContain("secret", "PII keyword");
    }

    @Test
    void dlpEventsAreContentFreeFilteredAndPaginated() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("dlp-events-owner"));
        UUID workspaceId = owner.workspace().id();
        UUID policyId = createDlpPolicy(owner, workspaceId, "Event rule", "BLOCK", "KEYWORD",
                "card");

        Instant now = Instant.now();
        UUID warnOlder = UUID.randomUUID();
        UUID blockNewest = UUID.randomUUID();
        UUID warnNewest = UUID.randomUUID();
        insertDlpEvent(warnOlder, workspaceId, policyId, "Event rule", "WARN",
                owner.user().id(), owner.chat().id(), now.minusSeconds(30));
        insertDlpEvent(blockNewest, workspaceId, policyId, "Event rule", "BLOCK",
                owner.user().id(), owner.chat().id(), now.minusSeconds(20));
        insertDlpEvent(warnNewest, workspaceId, policyId, "Event rule", "WARN",
                owner.user().id(), owner.chat().id(), now.minusSeconds(10));

        MvcResult filtered = mockMvc.perform(authed(
                        get("/api/v1/workspaces/{id}/dlp/events", workspaceId)
                                .param("policy_id", policyId.toString())
                                .param("action", "BLOCK"), owner))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode filteredBody = json(filtered);
        CONTRACT.assertValid("DlpEventPage", filteredBody);
        assertThat(filteredBody.get("items")).hasSize(1);
        assertThat(filteredBody.at("/items/0/id").asText())
                .isEqualTo(blockNewest.toString());
        assertThat(filteredBody.at("/items/0/policy_name").asText()).isEqualTo("Event rule");

        MvcResult firstPage = mockMvc.perform(authed(
                        get("/api/v1/workspaces/{id}/dlp/events", workspaceId)
                                .param("limit", "2"), owner))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode firstBody = json(firstPage);
        assertThat(firstBody.get("items")).hasSize(2);
        assertThat(firstBody.get("has_more").asBoolean()).isTrue();
        String cursor = firstBody.get("next_cursor").asText();
        assertThat(cursor).isNotBlank();

        MvcResult secondPage = mockMvc.perform(authed(
                        get("/api/v1/workspaces/{id}/dlp/events", workspaceId)
                                .param("limit", "2").param("cursor", cursor), owner))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode secondBody = json(secondPage);
        assertThat(secondBody.get("items")).hasSize(1);
        assertThat(secondBody.get("has_more").asBoolean()).isFalse();
        assertThat(secondBody.at("/items/0/id").asText()).isEqualTo(warnOlder.toString());

        String raw = firstPage.getResponse().getContentAsString()
                + secondPage.getResponse().getContentAsString();
        assertThat(raw).doesNotContain("\"text\"", "\"content\"", "\"message\"",
                "\"ip\"", "\"ip_address\"", "\"email\"", "203.0.113");

        mockMvc.perform(authed(get("/api/v1/workspaces/{id}/dlp/events", workspaceId)
                        .param("action", "ALERT"), owner))
                .andExpect(status().isBadRequest());
        mockMvc.perform(authed(get("/api/v1/workspaces/{id}/dlp/events", workspaceId)
                        .param("cursor", "not-a-cursor"), owner))
                .andExpect(status().isBadRequest());
    }

    @Test
    void auditFiltersCursorAndCrossWorkspaceIsolation() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("audit-owner"));
        UUID workspaceId = owner.workspace().id();
        SessionResponse outsider = devSession(uniqueDisplayName("audit-outsider"));

        mockMvc.perform(authed(patch("/api/v1/workspaces/{id}/security", workspaceId), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("require_2fa", true))))
                .andExpect(status().isOk());
        for (int index = 0; index < 3; index++) {
            createDlpPolicy(owner, workspaceId, "Audit rule " + index, "WARN", "KEYWORD",
                    "term-" + index);
        }
        // An outsider's own workspace event must never appear in this workspace's view.
        mockMvc.perform(authed(
                        patch("/api/v1/workspaces/{id}/security", outsider.workspace().id()),
                        outsider)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("require_2fa", true))))
                .andExpect(status().isOk());

        MvcResult page = mockMvc.perform(authed(
                        get("/api/v1/workspaces/{id}/audit", workspaceId)
                                .param("action", "workspace.security.updated"), owner))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode pageBody = json(page);
        CONTRACT.assertValid("WorkspaceAuditPage", pageBody);
        assertThat(pageBody.get("items")).hasSize(1);
        assertThat(pageBody.at("/items/0/actor_id").asText())
                .isEqualTo(owner.user().id().toString());
        assertThat(page.getResponse().getContentAsString())
                .doesNotContain("metadata", "actor_email", "request_id", "hash");

        MvcResult byActor = mockMvc.perform(authed(
                        get("/api/v1/workspaces/{id}/audit", workspaceId)
                                .param("actor_id", owner.user().id().toString())
                                .param("from", Instant.now().minusSeconds(600).toString())
                                .param("to", Instant.now().plusSeconds(600).toString()), owner))
                .andExpect(status().isOk())
                .andReturn();
        for (JsonNode item : json(byActor).get("items")) {
            assertThat(item.get("actor_id").asText())
                    .isEqualTo(owner.user().id().toString());
        }

        MvcResult badRange = mockMvc.perform(authed(
                        get("/api/v1/workspaces/{id}/audit", workspaceId)
                                .param("from", Instant.now().plusSeconds(60).toString())
                                .param("to", Instant.now().minusSeconds(60).toString()), owner))
                .andExpect(status().isBadRequest())
                .andReturn();
        assertThat(json(badRange).get("code").asText()).isEqualTo("VALIDATION_FAILED");

        MvcResult first = mockMvc.perform(authed(
                        get("/api/v1/workspaces/{id}/audit", workspaceId)
                                .param("action", "workspace.dlp.policy.created")
                                .param("limit", "2"), owner))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode firstBody = json(first);
        assertThat(firstBody.get("items")).hasSize(2);
        assertThat(firstBody.get("has_more").asBoolean()).isTrue();
        String cursor = firstBody.get("next_cursor").asText();
        MvcResult second = mockMvc.perform(authed(
                        get("/api/v1/workspaces/{id}/audit", workspaceId)
                                .param("action", "workspace.dlp.policy.created")
                                .param("limit", "2").param("cursor", cursor), owner))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode secondBody = json(second);
        assertThat(secondBody.get("items")).hasSize(1);
        assertThat(secondBody.get("has_more").asBoolean()).isFalse();
        for (JsonNode firstItem : firstBody.get("items")) {
            for (JsonNode secondItem : secondBody.get("items")) {
                assertThat(firstItem.get("id").asText())
                        .isNotEqualTo(secondItem.get("id").asText());
            }
        }

        mockMvc.perform(authed(get("/api/v1/workspaces/{id}/audit", workspaceId)
                        .param("cursor", "garbage"), owner))
                .andExpect(status().isBadRequest());
    }

    @Test
    void auditExportCsvJsonAndTruncationAreBounded() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("audit-export-owner"));
        UUID workspaceId = owner.workspace().id();
        createDlpPolicy(owner, workspaceId, "Export rule", "WARN", "PATTERN", "token*");

        MvcResult csv = mockMvc.perform(authed(
                        get("/api/v1/workspaces/{id}/audit/export", workspaceId)
                                .param("format", "csv")
                                .param("action", "workspace.dlp.policy.created"), owner))
                .andExpect(status().isOk())
                .andExpect(header().string("X-Export-Truncated", "false"))
                .andReturn();
        assertThat(csv.getResponse().getContentType()).startsWith("text/csv");
        assertThat(csv.getResponse().getHeader("Content-Disposition"))
                .contains("attachment; filename=\"workspace-audit-");
        String csvBody = csv.getResponse().getContentAsString();
        assertThat(csvBody).startsWith("created_at,action,actor_id,target_type,target_id\n");
        assertThat(csvBody.strip().split("\n")).hasSize(2);

        MvcResult jsonExport = mockMvc.perform(authed(
                        get("/api/v1/workspaces/{id}/audit/export", workspaceId)
                                .param("format", "json")
                                .param("action", "workspace.dlp.policy.created"), owner))
                .andExpect(status().isOk())
                .andExpect(header().string("X-Export-Truncated", "false"))
                .andReturn();
        JsonNode export = json(jsonExport);
        CONTRACT.assertValid("WorkspaceAuditExport", export);
        assertThat(export.get("exported_rows").asInt()).isGreaterThanOrEqualTo(1);
        assertThat(export.get("truncated").asBoolean()).isFalse();

        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM audit.audit_events
                 WHERE action = 'workspace.audit.exported' AND workspace_id = ?
                """, Integer.class, workspaceId)).isGreaterThanOrEqualTo(2);

        insertBulkAuditRows(workspaceId, 10_001);
        MvcResult truncated = mockMvc.perform(authed(
                        get("/api/v1/workspaces/{id}/audit/export", workspaceId)
                                .param("format", "csv").param("action", "test.bulk"), owner))
                .andExpect(status().isOk())
                .andExpect(header().string("X-Export-Truncated", "true"))
                .andExpect(header().string("X-Export-Rows", "10000"))
                .andReturn();
        assertThat(truncated.getResponse().getContentAsString().strip().split("\n"))
                .hasSize(10_001);

        mockMvc.perform(authed(get("/api/v1/workspaces/{id}/audit/export", workspaceId),
                        owner))
                .andExpect(status().isBadRequest());
        mockMvc.perform(authed(get("/api/v1/workspaces/{id}/audit/export", workspaceId)
                        .param("format", "xml"), owner))
                .andExpect(status().isBadRequest());
    }

    @Test
    void securitySettingsDefaultsPatchAndImmutableMode() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("security-owner"));
        UUID workspaceId = owner.workspace().id();

        MvcResult defaults = mockMvc.perform(authed(
                        get("/api/v1/workspaces/{id}/security", workspaceId), owner))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode defaultBody = json(defaults);
        CONTRACT.assertValid("WorkspaceSecurity", defaultBody);
        assertThat(defaultBody.get("require_2fa").asBoolean()).isFalse();
        assertThat(defaultBody.get("session_timeout_minutes").asInt()).isEqualTo(60);
        assertThat(defaultBody.get("dlp_enabled").asBoolean()).isFalse();
        assertThat(defaultBody.get("retention_days").asInt()).isEqualTo(180);
        assertThat(defaultBody.get("updated_at").asText()).isNotBlank();

        MvcResult patched = mockMvc.perform(authed(
                        patch("/api/v1/workspaces/{id}/security", workspaceId), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "require_2fa", true,
                                "retention_days", 30))))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode patchedBody = json(patched);
        CONTRACT.assertValid("WorkspaceSecurity", patchedBody);
        assertThat(patchedBody.get("require_2fa").asBoolean()).isTrue();
        assertThat(patchedBody.get("retention_days").asInt()).isEqualTo(30);
        assertThat(patchedBody.get("session_timeout_minutes").asInt()).isEqualTo(60);

        // Same values: idempotent, no second audit event.
        mockMvc.perform(authed(patch("/api/v1/workspaces/{id}/security", workspaceId), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "require_2fa", true, "retention_days", 30))))
                .andExpect(status().isOk());
        assertThat(auditCount(workspaceId, "workspace.security.updated", null)).isEqualTo(1L);

        mockMvc.perform(authed(patch("/api/v1/workspaces/{id}/security", workspaceId), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(
                                Map.of("session_timeout_minutes", 14))))
                .andExpect(status().isBadRequest());
        mockMvc.perform(authed(patch("/api/v1/workspaces/{id}/security", workspaceId), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{}"))
                .andExpect(status().isBadRequest());

        MvcResult mode = mockMvc.perform(authed(
                        patch("/api/v1/workspaces/{id}/security", workspaceId), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "security_mode", "E2EE"))))
                .andExpect(status().isUnprocessableEntity())
                .andReturn();
        assertThat(json(mode).get("code").asText()).isEqualTo("MODE_CHANGE_FORBIDDEN");
        CONTRACT.assertValid("Error", json(mode));
        assertThat(migrator().queryForObject(
                "SELECT security_mode FROM workspace.workspaces WHERE id = ?", String.class,
                workspaceId)).isEqualTo("MANAGED");

        MvcResult dlp = mockMvc.perform(authed(
                        patch("/api/v1/workspaces/{id}/security", workspaceId), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("dlp_enabled", true))))
                .andExpect(status().isOk())
                .andReturn();
        assertThat(json(dlp).get("dlp_enabled").asBoolean()).isTrue();
        assertThat(migrator().queryForObject("""
                SELECT metadata::text FROM audit.audit_events
                 WHERE action = 'workspace.security.updated' AND workspace_id = ?
                 ORDER BY created_at DESC LIMIT 1
                """, String.class, workspaceId)).contains("changed", "dlp_enabled")
                .doesNotContain("true", "180");
    }

    @Test
    void e2eeWorkspaceRejectsDlpAndModeSwitch() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("e2ee-owner"));
        UUID workspaceId = createE2eeWorkspace(owner, "e2ee-security");

        MvcResult security = mockMvc.perform(authed(
                        get("/api/v1/workspaces/{id}/security", workspaceId), owner))
                .andExpect(status().isOk())
                .andReturn();
        CONTRACT.assertValid("WorkspaceSecurity", json(security));

        MvcResult dlpOn = mockMvc.perform(authed(
                        patch("/api/v1/workspaces/{id}/security", workspaceId), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("dlp_enabled", true))))
                .andExpect(status().isUnprocessableEntity())
                .andReturn();
        assertThat(json(dlpOn).get("code").asText()).isEqualTo("DLP_E2EE_UNSUPPORTED");

        MvcResult e2eePolicies = mockMvc.perform(authed(
                        get("/api/v1/workspaces/{id}/dlp/policies", workspaceId), owner))
                .andExpect(status().isOk())
                .andReturn();
        assertThat(json(e2eePolicies).get("items")).isEmpty();

        MvcResult create = mockMvc.perform(authed(
                        post("/api/v1/workspaces/{id}/dlp/policies", workspaceId), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(dlpBody("blocked", "BLOCK", "KEYWORD", "x", true)))
                .andExpect(status().isUnprocessableEntity())
                .andReturn();
        assertThat(json(create).get("code").asText()).isEqualTo("DLP_E2EE_UNSUPPORTED");

        MvcResult mode = mockMvc.perform(authed(
                        patch("/api/v1/workspaces/{id}/security", workspaceId), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "security_mode", "MANAGED"))))
                .andExpect(status().isUnprocessableEntity())
                .andReturn();
        assertThat(json(mode).get("code").asText()).isEqualTo("MODE_CHANGE_FORBIDDEN");
        assertThat(migrator().queryForObject(
                "SELECT security_mode FROM workspace.workspaces WHERE id = ?", String.class,
                workspaceId)).isEqualTo("E2EE");
    }

    @Test
    void managerSurfaceRequiresOwnerOrAdmin() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("perm-owner"));
        SessionResponse member = devSession(uniqueDisplayName("perm-member"));
        SessionResponse outsider = devSession(uniqueDisplayName("perm-outsider"));
        UUID workspaceId = owner.workspace().id();
        addWorkspaceMember(owner, workspaceId, emailOf(member.user().id()), "MEMBER");

        for (var request : java.util.List.of(
                get("/api/v1/workspaces/{id}/dlp/policies", workspaceId),
                get("/api/v1/workspaces/{id}/audit", workspaceId),
                get("/api/v1/workspaces/{id}/sessions", workspaceId),
                get("/api/v1/workspaces/{id}/security", workspaceId),
                get("/api/v1/workspaces/{id}/audit/export", workspaceId)
                        .param("format", "json"),
                post("/api/v1/workspaces/{id}/dlp/policies", workspaceId)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(dlpBody("member-rule", "WARN", "KEYWORD", "x", true)),
                post("/api/v1/workspaces/{id}/sessions/revoke-all", workspaceId))) {
            MvcResult denied = mockMvc.perform(authed(request, member))
                    .andExpect(status().isForbidden())
                    .andReturn();
            assertThat(json(denied).get("code").asText()).isEqualTo("FORBIDDEN");
        }

        mockMvc.perform(authed(get("/api/v1/workspaces/{id}/security", workspaceId), outsider))
                .andExpect(status().isForbidden());
        mockMvc.perform(authed(get("/api/v1/workspaces/{id}/audit", workspaceId), outsider))
                .andExpect(status().isForbidden());
        mockMvc.perform(get("/api/v1/workspaces/{id}/security", workspaceId))
                .andExpect(status().isUnauthorized());

        // An ADMIN (not only the OWNER) may manage the same surface.
        mockMvc.perform(authed(patch("/api/v1/workspaces/{workspaceId}/members/{userId}",
                                workspaceId, member.user().id()), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("role", "ADMIN"))))
                .andExpect(status().isOk());
        mockMvc.perform(authed(get("/api/v1/workspaces/{id}/security", workspaceId), member))
                .andExpect(status().isOk());
        MvcResult adminCreate = mockMvc.perform(authed(
                        post("/api/v1/workspaces/{id}/dlp/policies", workspaceId), member)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(dlpBody("admin-rule", "BLOCK", "KEYWORD", "x", true)))
                .andExpect(status().isCreated())
                .andReturn();
        UUID policyId = UUID.fromString(json(adminCreate).get("id").asText());
        mockMvc.perform(authed(delete("/api/v1/workspaces/{id}/dlp/policies/{policyId}",
                                workspaceId, policyId), member))
                .andExpect(status().isNoContent());
    }

    @Test
    void devSessionsAreEmptyAndRevokeAllIsSafeWithoutKeycloakIdentities() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("sessions-owner"));
        UUID workspaceId = owner.workspace().id();

        MvcResult list = mockMvc.perform(authed(
                        get("/api/v1/workspaces/{id}/sessions", workspaceId), owner))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode body = json(list);
        CONTRACT.assertValid("WorkspaceSessionPage", body);
        assertThat(body.get("items")).isEmpty();
        assertThat(body.get("has_more").asBoolean()).isFalse();
        assertThat(list.getResponse().getContentAsString())
                .doesNotContain("ip_address", "ipAddress", "email", "access_token");

        mockMvc.perform(authed(delete("/api/v1/workspaces/{id}/sessions/{sessionId}",
                                workspaceId, UUID.randomUUID()), owner))
                .andExpect(status().isNotFound());

        MvcResult revokeAll = mockMvc.perform(authed(
                        post("/api/v1/workspaces/{id}/sessions/revoke-all", workspaceId), owner))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode revokeBody = json(revokeAll);
        CONTRACT.assertValid("WorkspaceSessionRevokeAll", revokeBody);
        assertThat(revokeBody.get("revoked_sessions").asInt()).isZero();
        assertThat(revokeBody.get("affected_users").asInt()).isZero();
        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM audit.audit_events
                 WHERE action = 'workspace.sessions.revoked_all' AND workspace_id = ?
                """, Integer.class, workspaceId)).isEqualTo(1);
    }

    private void assertBadDlp(SessionResponse owner, UUID workspaceId, String body)
            throws Exception {
        MvcResult result = mockMvc.perform(authed(
                        post("/api/v1/workspaces/{id}/dlp/policies", workspaceId), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isBadRequest())
                .andReturn();
        assertThat(json(result).get("code").asText()).isEqualTo("VALIDATION_FAILED");
    }

    private String dlpBody(String name, String action, String patternType, String pattern,
                           boolean enabled) throws Exception {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("name", name);
        body.put("action", action);
        body.put("pattern_type", patternType);
        body.put("pattern", pattern);
        body.put("enabled", enabled);
        return objectMapper.writeValueAsString(body);
    }

    private UUID createDlpPolicy(SessionResponse owner, UUID workspaceId, String name,
                                 String action, String patternType, String pattern)
            throws Exception {
        MvcResult result = mockMvc.perform(authed(
                        post("/api/v1/workspaces/{id}/dlp/policies", workspaceId), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(dlpBody(name, action, patternType, pattern, true)))
                .andExpect(status().isCreated())
                .andReturn();
        return UUID.fromString(json(result).get("id").asText());
    }

    private void addWorkspaceMember(SessionResponse owner, UUID workspaceId, String email,
                                    String role) throws Exception {
        mockMvc.perform(authed(post("/api/v1/workspaces/{workspaceId}/members",
                                workspaceId), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "email", email, "role", role))))
                .andExpect(status().isCreated());
    }

    private UUID createE2eeWorkspace(SessionResponse owner, String name) {
        UUID workspaceId = UUID.randomUUID();
        migrator().update("""
                INSERT INTO workspace.workspaces
                       (id, name, slug, security_mode, status, created_by)
                VALUES (?, ?, ?, 'E2EE', 'ACTIVE', ?)
                """, workspaceId, name, name + "-" + workspaceId, owner.user().id());
        migrator().update("""
                INSERT INTO workspace.memberships (workspace_id, user_id, role, status)
                VALUES (?, ?, 'OWNER', 'ACTIVE')
                """, workspaceId, owner.user().id());
        return workspaceId;
    }

    private String emailOf(UUID userId) {
        return migrator().queryForObject("SELECT email::text FROM auth.users WHERE id = ?",
                String.class, userId);
    }

    private void insertDlpEvent(UUID id, UUID workspaceId, UUID policyId, String ruleName,
                                String action, UUID actorId, UUID chatId, Instant createdAt) {
        migrator().update("""
                INSERT INTO workspace.dlp_events
                       (id, workspace_id, policy_id, rule_name, action, actor_id, chat_id,
                        created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """, id, workspaceId, policyId, ruleName, action, actorId, chatId,
                Timestamp.from(createdAt));
    }

    private void insertBulkAuditRows(UUID workspaceId, int count) {
        migrator().update("""
                INSERT INTO audit.audit_events
                       (id, scope_key, workspace_id, seq, actor_type, actor_id, action,
                        target_type, target_id, request_id, metadata, prev_hash, hash,
                        created_at)
                SELECT gen_random_uuid(), 'bulk:' || ? || ':' || g, ?, g, 'SYSTEM', NULL,
                       'test.bulk', NULL, NULL, NULL, '{}'::jsonb, '\\x00'::bytea,
                       '\\x00'::bytea, now() - (g || ' seconds')::interval
                  FROM generate_series(1, ?) AS g
                """, workspaceId, workspaceId, count);
    }

    private long auditCount(UUID workspaceId, String action, UUID targetId) {
        if (targetId == null) {
            Long count = migrator().queryForObject("""
                    SELECT count(*) FROM audit.audit_events
                     WHERE action = ? AND workspace_id = ?
                    """, Long.class, action, workspaceId);
            return count == null ? 0 : count;
        }
        Long count = migrator().queryForObject("""
                SELECT count(*) FROM audit.audit_events
                 WHERE action = ? AND workspace_id = ? AND target_id = ?
                """, Long.class, action, workspaceId, targetId);
        return count == null ? 0 : count;
    }
}
