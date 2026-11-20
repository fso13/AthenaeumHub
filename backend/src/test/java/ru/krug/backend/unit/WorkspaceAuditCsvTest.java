package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import org.junit.jupiter.api.Test;

import ru.krug.backend.workspace.api.mapper.WorkspaceSecurityApiMapper;
import ru.krug.backend.workspace.application.model.WorkspaceAuditExportView;
import ru.krug.backend.workspace.application.model.WorkspaceAuditView;

/** RFC 4180 escaping of the bounded workspace audit export. */
class WorkspaceAuditCsvTest {

    @Test
    void writesHeaderAndQuotesCommaQuoteAndNewlineOnly() {
        WorkspaceAuditView plain = new WorkspaceAuditView(UUID.randomUUID(), "plain.action",
                UUID.randomUUID(), "user", UUID.randomUUID(),
                Instant.parse("2026-11-20T10:00:00Z"));
        WorkspaceAuditView tricky = new WorkspaceAuditView(UUID.randomUUID(),
                "a,\"b\"", null, "line\nbreak", null,
                Instant.parse("2026-11-20T10:01:00Z"));
        String csv = WorkspaceSecurityApiMapper.toCsv(
                new WorkspaceAuditExportView(List.of(plain, tricky), 2, false));

        assertThat(csv).startsWith(
                "created_at,action,actor_id,target_type,target_id\n");
        assertThat(csv).contains("2026-11-20T10:00:00Z,plain.action,");
        assertThat(csv).contains("\"a,\"\"b\"\"\"");
        assertThat(csv).contains("\"line\nbreak\"");
        // A null id is an empty field, never the literal "null".
        assertThat(csv).doesNotContain("null");
    }

    @Test
    void emptyExportIsHeaderOnly() {
        String csv = WorkspaceSecurityApiMapper.toCsv(
                new WorkspaceAuditExportView(List.of(), 0, false));
        assertThat(csv).isEqualTo("created_at,action,actor_id,target_type,target_id\n");
    }
}
