package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Map;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MvcResult;

import ru.krug.backend.file.application.usecase.QuotaReconciliationHandler;
import ru.krug.backend.file.application.usecase.UploadGcHandler;
import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.support.FileUploadTestSupport;

/** GC/reconcile paths that are scheduled in production but invoked directly here. */
@ActiveProfiles("test")
class FileMaintenanceIT extends FileUploadTestSupport {

    @Autowired
    private UploadGcHandler gcHandler;

    @Autowired
    private QuotaReconciliationHandler reconciliationHandler;

    @Test
    void expiredActiveUploadReleasesReservationAndReturns410() throws Exception {
        SessionResponse session = devSession();
        byte[] data = randomBytes(1024);
        JsonNode init = initOk(session, session.chat().id(), "expired.bin", data,
                "application/octet-stream");
        UUID uploadId = UUID.fromString(init.get("upload_id").asText());
        assertThat(((Number) usage(session.workspace().id()).get("reserved_bytes")).longValue())
                .isEqualTo(1024);

        migrator().update("UPDATE file.uploads SET expires_at = now() - interval '1 hour'"
                + " WHERE id = ?", uploadId);
        gcHandler.gcOne(uploadId);

        assertThat(((Number) usage(session.workspace().id()).get("reserved_bytes")).longValue())
                .isZero();
        assertThat(migrator().queryForObject(
                "SELECT status FROM file.uploads WHERE id = ?", String.class, uploadId))
                .isEqualTo("EXPIRED");
        assertThat(migrator().queryForObject(
                "SELECT status FROM file.quota_reservations WHERE upload_id = ?", String.class,
                uploadId)).isEqualTo("EXPIRED");

        MvcResult get = getUpload(session, uploadId);
        assertThat(get.getResponse().getStatus()).isEqualTo(410);
        assertThat(json(get).get("code").asText()).isEqualTo("UPLOAD_EXPIRED");
    }

    @Test
    void expiredUnboundCompletedUploadDeletesObjectAndReleasesUsedQuota() throws Exception {
        SessionResponse session = devSession();
        UUID workspaceId = session.workspace().id();
        byte[] data = randomBytes(2048);
        JsonNode upload = uploadFile(session, session.chat().id(), "gc-complete.bin", data,
                "application/octet-stream");
        UUID uploadId = UUID.fromString(upload.get("upload_id").asText());
        UUID attachmentId = UUID.fromString(upload.get("attachment_id").asText());
        assertThat(((Number) usage(workspaceId).get("used_bytes")).longValue())
                .isEqualTo(2048);

        migrator().update("UPDATE file.uploads SET expires_at = now() - interval '1 hour'"
                + " WHERE id = ?", uploadId);
        gcHandler.gcOne(uploadId);

        Map<String, Object> after = usage(workspaceId);
        assertThat(((Number) after.get("used_bytes")).longValue()).isZero();
        assertThat(((Number) after.get("reserved_bytes")).longValue()).isZero();
        assertThat(migrator().queryForObject(
                "SELECT status FROM file.attachments WHERE id = ?", String.class, attachmentId))
                .isEqualTo("DELETED");
        assertThat(migrator().queryForObject(
                "SELECT status FROM file.quota_reservations WHERE upload_id = ?", String.class,
                uploadId)).isEqualTo("RELEASED");
        assertThat(migrator().queryForObject(
                "SELECT status FROM file.uploads WHERE id = ?", String.class, uploadId))
                .isEqualTo("EXPIRED");
        assertThat(downloadUrl(session, attachmentId).getResponse().getStatus()).isEqualTo(410);
    }

    @Test
    void reconciliationRepairsDriftedUsageFromAttachments() throws Exception {
        SessionResponse session = devSession();
        UUID workspaceId = session.workspace().id();
        byte[] data = randomBytes(4096);
        uploadFile(session, session.chat().id(), "reconcile.bin", data,
                "application/octet-stream");

        migrator().update("UPDATE file.workspace_usage SET used_bytes = 9999,"
                + " reserved_bytes = 7777 WHERE workspace_id = ?", workspaceId);
        int reconciled = reconciliationHandler.reconcile(10_000);
        assertThat(reconciled).isGreaterThanOrEqualTo(1);

        Map<String, Object> after = usage(workspaceId);
        assertThat(((Number) after.get("used_bytes")).longValue()).isEqualTo(data.length);
        assertThat(((Number) after.get("reserved_bytes")).longValue()).isZero();
    }
}
