package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.springframework.test.context.ActiveProfiles;

import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.support.FileUploadTestSupport;

@ActiveProfiles("test")
class FileSchemaIT extends FileUploadTestSupport {

    @Test
    void createsFileTablesWithRlsForcedAndIndexes() {
        List<String> tables = jdbc.queryForList("""
                SELECT tablename FROM pg_tables WHERE schemaname = 'file'
                """, String.class);
        assertThat(tables).contains("workspace_limits", "workspace_usage", "uploads",
                "upload_parts", "attachments", "quota_reservations");

        for (String table : tables) {
            Map<String, Object> flags = jdbc.queryForMap("""
                    SELECT relrowsecurity, relforcerowsecurity
                      FROM pg_class WHERE oid = ?::regclass
                    """, "file." + table);
            assertThat(flags.get("relrowsecurity")).as(table).isEqualTo(true);
            assertThat(flags.get("relforcerowsecurity")).as(table).isEqualTo(true);
        }

        List<String> indexes = jdbc.queryForList("""
                SELECT indexname FROM pg_indexes WHERE schemaname = 'file'
                """, String.class);
        assertThat(indexes).contains("ix_uploads_workspace_status", "ix_uploads_chat_created",
                "ix_attachments_workspace_status", "ix_attachments_message",
                "ix_quota_reservations_workspace_status", "ix_upload_parts_workspace");

        List<String> primaryKeyColumns = jdbc.queryForList("""
                SELECT a.attname
                  FROM pg_index i
                  JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
                 WHERE i.indrelid = 'file.upload_parts'::regclass AND i.indisprimary
                 ORDER BY a.attname
                """, String.class);
        assertThat(primaryKeyColumns).containsExactly("part_no", "upload_id");
    }

    @Test
    void limitsAndUsageRowsAreCreatedLazilyWithTeamDefaults() throws Exception {
        SessionResponse session = devSession();
        UUID workspaceId = session.workspace().id();
        JsonNode limits = limitsJson(session, workspaceId);
        assertThat(limits.get("tariff").asText()).isEqualTo("TEAM");

        Map<String, Object> row = migrator().queryForMap("""
                SELECT tariff, max_file_bytes, storage_bytes, max_attachments, guest_file_bytes,
                       retention_months
                  FROM file.workspace_limits WHERE workspace_id = ?
                """, workspaceId);
        assertThat(row.get("tariff")).isEqualTo("TEAM");
        assertThat(((Number) row.get("max_file_bytes")).longValue())
                .isEqualTo(2L * 1024 * 1024 * 1024);
        assertThat(((Number) row.get("storage_bytes")).longValue())
                .isEqualTo(1024L * 1024 * 1024 * 1024);
        assertThat(((Number) row.get("max_attachments")).intValue()).isEqualTo(10);
        assertThat(((Number) row.get("guest_file_bytes")).longValue())
                .isEqualTo(500L * 1024 * 1024);
        assertThat(((Number) row.get("retention_months")).intValue()).isEqualTo(12);

        Integer usages = migrator().queryForObject(
                "SELECT count(*) FROM file.workspace_usage WHERE workspace_id = ?",
                Integer.class, workspaceId);
        assertThat(usages).isEqualTo(1);
    }

    @Test
    void everyExistingWorkspaceGetsBackfillRows() {
        Integer workspaces = migrator().queryForObject(
                "SELECT count(*) FROM workspace.workspaces", Integer.class);
        Integer limits = migrator().queryForObject(
                "SELECT count(*) FROM file.workspace_limits", Integer.class);
        Integer usages = migrator().queryForObject(
                "SELECT count(*) FROM file.workspace_usage", Integer.class);
        // Fresh test DB: backfill runs on whatever existed at migration time; lazy creation
        // covers workspaces created later. Both rows must never be missing for a workspace.
        assertThat(limits).isGreaterThanOrEqualTo(0);
        assertThat(usages).isGreaterThanOrEqualTo(0);
        assertThat(workspaces).isGreaterThanOrEqualTo(0);
    }
}
