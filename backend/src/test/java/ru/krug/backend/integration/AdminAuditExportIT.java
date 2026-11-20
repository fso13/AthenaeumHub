package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MvcResult;

import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.support.IntegrationTestBase;
import ru.krug.backend.support.OpenApiContract;

/**
 * #84: bounded platform-audit export. CSV is RFC 4180 with the documented header, JSON is
 * the bounded {@code AdminAuditExport} object, truncation is signalled at 10 000 rows and a
 * non-admin is always 403.
 */
@ActiveProfiles("test")
class AdminAuditExportIT extends IntegrationTestBase {

    private static final OpenApiContract CONTRACT = OpenApiContract.load();
    private static final String BULK_ACTION = "test.admin.bulk";

    @BeforeEach
    void clearBulkRows() {
        migrator().update("DELETE FROM audit.audit_events WHERE action = ?", BULK_ACTION);
    }

    @Test
    void exportsCsvAndJsonAndRecordsTheExport() throws Exception {
        SessionResponse admin = adminSession();
        adminAuditPage(admin);

        MvcResult csv = mockMvc.perform(authed(
                        get("/api/v1/admin/audit/export").param("format", "csv")
                                .param("action", "admin.audit.viewed"), admin))
                .andExpect(status().isOk())
                .andExpect(header().string("X-Export-Truncated", "false"))
                .andReturn();
        assertThat(csv.getResponse().getContentType()).startsWith("text/csv");
        assertThat(csv.getResponse().getHeader("Content-Disposition"))
                .contains("attachment; filename=\"admin-audit-");
        String csvBody = csv.getResponse().getContentAsString();
        assertThat(csvBody).startsWith(
                "created_at,action,actor_id,actor_email,target_type,target_id\n");
        assertThat(csvBody.strip().split("\n")).hasSizeGreaterThanOrEqualTo(2);
        assertThat(Integer.parseInt(csv.getResponse().getHeader("X-Export-Rows")))
                .isGreaterThanOrEqualTo(1);

        MvcResult jsonExport = mockMvc.perform(authed(
                        get("/api/v1/admin/audit/export").param("format", "json")
                                .param("action", "admin.audit.viewed"), admin))
                .andExpect(status().isOk())
                .andExpect(header().string("X-Export-Truncated", "false"))
                .andReturn();
        JsonNode body = json(jsonExport);
        CONTRACT.assertValid("AdminAuditExport", body);
        assertThat(body.get("exported_rows").asInt()).isGreaterThanOrEqualTo(1);
        assertThat(body.get("truncated").asBoolean()).isFalse();
        assertThat(body.at("/items/0/action").asText()).isEqualTo("admin.audit.viewed");

        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM audit.audit_events
                 WHERE action = 'admin.audit.exported'
                """, Integer.class)).isGreaterThanOrEqualTo(2);
        String metadata = migrator().queryForObject("""
                SELECT metadata::text FROM audit.audit_events
                 WHERE action = 'admin.audit.exported'
                 ORDER BY created_at DESC LIMIT 1
                """, String.class);
        assertThat(metadata).contains("format", "returned", "truncated")
                .doesNotContain("admin.audit.viewed", "created_at");
    }

    @Test
    void truncatesAtTenThousandRows() throws Exception {
        SessionResponse admin = adminSession();
        insertBulkAuditRows(10_001);

        MvcResult truncated = mockMvc.perform(authed(
                        get("/api/v1/admin/audit/export").param("format", "csv")
                                .param("action", BULK_ACTION), admin))
                .andExpect(status().isOk())
                .andExpect(header().string("X-Export-Truncated", "true"))
                .andExpect(header().string("X-Export-Rows", "10000"))
                .andReturn();
        assertThat(truncated.getResponse().getContentAsString().strip().split("\n"))
                .hasSize(10_001);

        JsonNode jsonExport = json(mockMvc.perform(authed(
                        get("/api/v1/admin/audit/export").param("format", "json")
                                .param("action", BULK_ACTION), admin))
                .andExpect(status().isOk())
                .andReturn());
        CONTRACT.assertValid("AdminAuditExport", jsonExport);
        assertThat(jsonExport.get("exported_rows").asInt()).isEqualTo(10_000);
        assertThat(jsonExport.get("truncated").asBoolean()).isTrue();
    }

    @Test
    void rejectsMissingOrUnknownFormatAndNonAdmins() throws Exception {
        SessionResponse admin = adminSession();
        mockMvc.perform(authed(get("/api/v1/admin/audit/export"), admin))
                .andExpect(status().isBadRequest());
        mockMvc.perform(authed(get("/api/v1/admin/audit/export").param("format", "xml"),
                        admin))
                .andExpect(status().isBadRequest());
        mockMvc.perform(authed(get("/api/v1/admin/audit/export").param("format", "csv")
                        .param("action", "x".repeat(121)), admin))
                .andExpect(status().isBadRequest());

        SessionResponse user = devSession(uniqueDisplayName("export-user"));
        mockMvc.perform(authed(get("/api/v1/admin/audit/export").param("format", "csv"), user))
                .andExpect(status().isForbidden());
    }

    private void adminAuditPage(SessionResponse admin) throws Exception {
        mockMvc.perform(authed(get("/api/v1/admin/audit"), admin))
                .andExpect(status().isOk());
    }

    private SessionResponse adminSession() throws Exception {
        SessionResponse session = devSession(uniqueDisplayName("export-admin"));
        migrator().update("UPDATE auth.users SET is_platform_admin = false "
                + "WHERE is_platform_admin");
        migrator().update("UPDATE auth.users SET is_platform_admin = true WHERE id = ?",
                session.user().id());
        return session;
    }

    private void insertBulkAuditRows(int count) {
        migrator().update("""
                INSERT INTO audit.audit_events
                       (id, scope_key, workspace_id, seq, actor_type, actor_id, action,
                        target_type, target_id, request_id, metadata, prev_hash, hash,
                        created_at)
                SELECT gen_random_uuid(), 'bulk:admin:' || g, NULL, g, 'SYSTEM', NULL,
                       'test.admin.bulk', NULL, NULL, NULL, '{}'::jsonb, '\\x00'::bytea,
                       '\\x00'::bytea, now() - (g || ' seconds')::interval
                  FROM generate_series(1, ?) AS g
                """, count);
    }
}
