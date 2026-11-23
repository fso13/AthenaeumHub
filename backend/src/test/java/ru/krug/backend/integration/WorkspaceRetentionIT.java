package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.sql.Timestamp;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.RowCallbackHandler;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MvcResult;

import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.ops.application.model.WorkspaceRetentionReport;
import ru.krug.backend.ops.application.usecase.WorkspaceRetentionService;
import ru.krug.backend.support.FileUploadTestSupport;

/**
 * #101 daily workspace retention: per-workspace window, bounded/idempotent soft deletes,
 * attachment object removal, counters and tenant isolation.
 */
@ActiveProfiles("test")
class WorkspaceRetentionIT extends FileUploadTestSupport {

    @Autowired
    private WorkspaceRetentionService retentionService;

    @Test
    void softDeletesOnlyExpiredContentAndIsIdempotent() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("retention-owner"));
        UUID workspaceId = owner.workspace().id();
        UUID chatId = owner.chat().id();
        setRetentionDays(owner, workspaceId, 1);

        Instant old = Instant.now().minus(90, ChronoUnit.DAYS);
        ensurePartition(old);
        UUID oldMessage = insertMessage(owner, chatId, 9_001L, "old secret", old);
        UUID newMessage = insertMessage(owner, chatId, 9_002L, "fresh", Instant.now());

        // A real managed upload gives us an object in the storage adapter and a quota row.
        var upload = uploadFile(owner, chatId, "old-report.pdf",
                "old report".getBytes(java.nio.charset.StandardCharsets.UTF_8),
                "application/pdf");
        UUID attachmentId = UUID.fromString(upload.get("attachment_id").asText());
        String objectKey = attachmentObjectKey(attachmentId);
        migrator().update("UPDATE file.attachments SET created_at = ? WHERE id = ?",
                Timestamp.from(old), attachmentId);
        migrator().update("UPDATE file.uploads SET created_at = ? WHERE attachment_id = ?",
                Timestamp.from(old), attachmentId);
        assertThat(objectStorage.exists(objectKey)).isTrue();

        WorkspaceRetentionReport first = retentionService.run();

        assertThat(first.failedWorkspaces()).isZero();
        assertThat(first.messages()).isGreaterThanOrEqualTo(1);
        assertThat(first.files()).isGreaterThanOrEqualTo(1);
        assertThat(first.batches()).isGreaterThanOrEqualTo(1);

        Map<String, Object> oldRow = messageRow(oldMessage);
        assertThat(oldRow.get("deleted_at")).isNotNull();
        assertThat(oldRow.get("body_ciphertext")).isNull();
        assertThat(oldRow.get("content_meta").toString()).isEqualTo("{}");
        assertThat(oldRow.get("version")).isEqualTo(2);

        Map<String, Object> freshRow = messageRow(newMessage);
        assertThat(freshRow.get("deleted_at")).isNull();
        assertThat(freshRow.get("body_ciphertext")).isNotNull();

        Map<String, Object> attachment = migrator().queryForMap("""
                SELECT status, deleted_at FROM file.attachments WHERE id = ?
                """, attachmentId);
        assertThat(attachment.get("status")).isEqualTo("DELETED");
        assertThat(attachment.get("deleted_at")).isNotNull();
        assertThat(objectStorage.exists(objectKey)).isFalse();
        assertThat(migrator().queryForObject(
                "SELECT status FROM file.uploads WHERE attachment_id = ?", String.class,
                attachmentId)).isEqualTo("EXPIRED");

        Map<String, Object> run = migrator().queryForMap("""
                SELECT retention_days, messages_deleted, files_deleted, batches, status
                  FROM workspace.retention_runs
                 WHERE workspace_id = ?
                 ORDER BY started_at DESC, id DESC LIMIT 1
                """, workspaceId);
        assertThat(run.get("retention_days")).isEqualTo(1);
        assertThat(((Number) run.get("messages_deleted")).intValue())
                .isGreaterThanOrEqualTo(1);
        assertThat(((Number) run.get("files_deleted")).intValue()).isGreaterThanOrEqualTo(1);
        assertThat(run.get("status")).isEqualTo("COMPLETED");

        // A second run is a no-op for the already-tombstoned rows.
        WorkspaceRetentionReport second = retentionService.run();
        assertThat(second.messages()).isZero();
        assertThat(second.files()).isZero();
        assertThat(messageRow(oldMessage).get("deleted_at")).isEqualTo(
                oldRow.get("deleted_at"));
        assertThat(migrator().queryForObject(
                "SELECT status FROM file.attachments WHERE id = ?", String.class,
                attachmentId)).isEqualTo("DELETED");
    }

    @Test
    void aWorkspaceWindowNeverDeletesAnotherWorkspaceContent() throws Exception {
        SessionResponse strict = devSession(uniqueDisplayName("retention-strict"));
        SessionResponse relaxed = devSession(uniqueDisplayName("retention-relaxed"));
        setRetentionDays(strict, strict.workspace().id(), 1);

        Instant old = Instant.now().minus(90, ChronoUnit.DAYS);
        ensurePartition(old);
        UUID strictMessage = insertMessage(strict, strict.chat().id(), 9_101L, "strict",
                old);
        UUID relaxedMessage = insertMessage(relaxed, relaxed.chat().id(), 9_102L,
                "other tenant", old);

        retentionService.run();

        assertThat(messageRow(strictMessage).get("deleted_at")).isNotNull();
        assertThat(messageRow(relaxedMessage).get("deleted_at")).isNull();
        assertThat(messageRow(relaxedMessage).get("body_ciphertext")).isNotNull();
    }

    // ------------------------------------------------------------------

    private void setRetentionDays(SessionResponse session, UUID workspaceId, int days)
            throws Exception {
        mockMvc.perform(authed(patch("/api/v1/workspaces/{id}/security", workspaceId),
                        session)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("retention_days",
                                days))))
                .andExpect(status().isOk());
    }

    private void ensurePartition(Instant instant) {
        migrator().query("""
                SELECT message.ensure_partition(date_trunc('month', ?::timestamptz)::date)
                """, (RowCallbackHandler) rs -> { }, Timestamp.from(instant));
    }

    private UUID insertMessage(SessionResponse session, UUID chatId, long seq, String text,
                               Instant createdAt) {
        UUID id = UUID.randomUUID();
        migrator().update("""
                INSERT INTO message.messages
                       (id, workspace_id, chat_id, seq, sender_id, sender_type, type,
                        crypto_scheme, body_ciphertext, content_meta, created_at)
                VALUES (?, ?, ?, ?, ?, 'USER', 'TEXT', 'MANAGED', ?, ?::jsonb, ?)
                """, id, session.workspace().id(), chatId, seq, session.user().id(),
                text.getBytes(java.nio.charset.StandardCharsets.UTF_8),
                "{\"length\":" + text.length() + "}", Timestamp.from(createdAt));
        return id;
    }

    private Map<String, Object> messageRow(UUID messageId) {
        return migrator().queryForMap("""
                SELECT deleted_at, body_ciphertext, content_meta, version
                  FROM message.messages WHERE id = ?
                """, messageId);
    }

    private String attachmentObjectKey(UUID attachmentId) {
        return migrator().queryForObject(
                "SELECT object_key FROM file.attachments WHERE id = ?", String.class,
                attachmentId);
    }
}
