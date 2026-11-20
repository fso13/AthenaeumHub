package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import org.junit.jupiter.api.Test;

import ru.krug.backend.ops.api.mapper.AdminAuditExportMapper;
import ru.krug.backend.ops.application.model.AdminAuditExportView;
import ru.krug.backend.ops.application.model.AdminAuditView;

/** RFC 4180 escaping of the bounded platform-audit export. */
class AdminAuditCsvTest {

    @Test
    void writesTheSevenColumnHeader() {
        String csv = AdminAuditExportMapper.toCsv(
                new AdminAuditExportView(List.of(), 0, false));
        assertThat(csv).isEqualTo(
                "created_at,action,actor_id,actor_email,target_type,target_id\n");
    }

    @Test
    void quotesOnlyCommaQuoteCrAndLf() {
        AdminAuditView plain = new AdminAuditView(UUID.randomUUID(), "admin.audit.viewed",
                UUID.randomUUID(), "plain@example.test", "admin_audit", UUID.randomUUID(),
                Instant.parse("2026-11-20T10:00:00Z"));
        AdminAuditView tricky = new AdminAuditView(UUID.randomUUID(), "a,\"b\"",
                null, "comma,email@example.test", "line\nbreak", null,
                Instant.parse("2026-11-20T10:01:00Z"));
        String csv = AdminAuditExportMapper.toCsv(
                new AdminAuditExportView(List.of(plain, tricky), 2, false));

        assertThat(csv).contains("2026-11-20T10:00:00Z,admin.audit.viewed,");
        assertThat(csv).contains("\"a,\"\"b\"\"\"");
        assertThat(csv).contains("\"comma,email@example.test\"");
        assertThat(csv).contains("\"line\nbreak\"");
        assertThat(csv).doesNotContain("null");
    }

    @Test
    void emptyFieldsStayEmptyRatherThanTheLiteralNull() {
        String csv = AdminAuditExportMapper.toCsv(new AdminAuditExportView(
                List.of(new AdminAuditView(UUID.randomUUID(), "system.event", null, null,
                        null, null, Instant.parse("2026-11-20T10:00:00Z"))), 1, false));
        assertThat(csv).contains("system.event,,,,");
        assertThat(csv).doesNotContain("null");
    }
}
