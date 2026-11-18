package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.List;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.DataAccessException;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MvcResult;

import ru.krug.backend.file.application.usecase.FileAccessGuard;
import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.support.FileUploadTestSupport;

/** Cross-tenant proof for the E4-B tables and download endpoint under the real krug_app role. */
@ActiveProfiles("test")
class FileRlsIT extends FileUploadTestSupport {

    @Autowired
    private FileAccessGuard accessGuard;

    @Test
    void crossTenantUploadsAttachmentsPartsAndReservationsAreInvisible() throws Exception {
        SessionResponse alice = devSession();
        SessionResponse bob = devSession();
        byte[] data = randomBytes(128);
        JsonNode upload = uploadFile(alice, alice.chat().id(), "alice.txt", data, "text/plain");
        UUID uploadId = UUID.fromString(upload.get("upload_id").asText());
        UUID attachmentId = UUID.fromString(upload.get("attachment_id").asText());

        assertThat(getUpload(bob, uploadId).getResponse().getStatus()).isEqualTo(404);
        assertThat(downloadUrl(bob, attachmentId).getResponse().getStatus()).isEqualTo(404);

        UUID aliceWorkspace = alice.workspace().id();
        UUID bobWorkspace = bob.workspace().id();
        UUID aliceUser = alice.user().id();

        for (String table : new String[]{"uploads", "attachments", "upload_parts",
                "quota_reservations"}) {
            int visible = inTenant(aliceUser, aliceWorkspace, () -> jdbc.queryForObject(
                    "SELECT count(*) FROM file." + table + " WHERE workspace_id = ?",
                    Integer.class, bobWorkspace));
            assertThat(visible).as(table).isZero();
        }

        int aliceUploads = inTenant(aliceUser, aliceWorkspace, () -> jdbc.queryForObject(
                "SELECT count(*) FROM file.uploads WHERE workspace_id = ?", Integer.class,
                aliceWorkspace));
        assertThat(aliceUploads).isEqualTo(1);

        assertThat(jdbc.queryForObject("SELECT count(*) FROM file.uploads", Integer.class))
                .isZero();
        assertThat(jdbc.queryForObject("SELECT count(*) FROM file.attachments", Integer.class))
                .isZero();
    }

    @Test
    void workspaceResolversBindOnlyAuthorizedUsers() throws Exception {
        SessionResponse alice = devSession();
        SessionResponse bob = devSession();
        byte[] data = randomBytes(64);
        JsonNode upload = uploadFile(alice, alice.chat().id(), "resolve.txt", data,
                "text/plain");
        UUID uploadId = UUID.fromString(upload.get("upload_id").asText());
        UUID attachmentId = UUID.fromString(upload.get("attachment_id").asText());

        Principal aliceNoWorkspace = new Principal(alice.user().id(), alice.device().id(),
                null, "file-resolve-test");
        Principal bobNoWorkspace = new Principal(bob.user().id(), bob.device().id(), null,
                "file-resolve-test");

        assertThat(accessGuard.activateUploadScope(aliceNoWorkspace, uploadId).workspaceId())
                .isEqualTo(alice.workspace().id());
        assertThatThrownBy(() -> accessGuard.activateUploadScope(bobNoWorkspace, uploadId))
                .isInstanceOf(DomainException.class);

        assertThat(accessGuard.activateAttachmentScope(aliceNoWorkspace, attachmentId)
                .workspaceId()).isEqualTo(alice.workspace().id());
        assertThatThrownBy(() -> accessGuard.activateAttachmentScope(bobNoWorkspace,
                attachmentId)).isInstanceOf(DomainException.class);

        // A bound attachment resolves for an active workspace member, but never for a
        // stranger; the chat-membership check still runs afterwards.
        MvcResult send = sendWithAttachments(alice, alice.chat().id(), "bound",
                List.of(attachmentId));
        assertThat(send.getResponse().getStatus()).isEqualTo(201);
        assertThat(accessGuard.activateAttachmentScope(aliceNoWorkspace, attachmentId)
                .workspaceId()).isEqualTo(alice.workspace().id());
        assertThatThrownBy(() -> accessGuard.activateAttachmentScope(bobNoWorkspace,
                attachmentId)).isInstanceOf(DomainException.class);
    }

    @Test
    void writesIntoAnotherTenantAreRejectedForEveryFileTable() throws Exception {
        SessionResponse alice = devSession();
        SessionResponse bob = devSession();
        byte[] data = randomBytes(64);
        JsonNode upload = uploadFile(alice, alice.chat().id(), "a.txt", data, "text/plain");
        UUID uploadId = UUID.fromString(upload.get("upload_id").asText());
        UUID attachmentId = UUID.fromString(upload.get("attachment_id").asText());

        assertThatThrownBy(() -> inTenant(alice.user().id(), alice.workspace().id(),
                () -> jdbc.update("""
                        INSERT INTO file.uploads
                               (id, workspace_id, chat_id, user_id, filename, size_bytes, status,
                                part_size, total_parts, object_key, expires_at)
                        VALUES (?, ?, ?, ?, 'hijack', 1, 'INIT', 8388608, 1, ?, now() + interval '1 hour')
                        """, UUID.randomUUID(), bob.workspace().id(), bob.chat().id(),
                        alice.user().id(), "hijack-" + UUID.randomUUID())))
                .isInstanceOf(DataAccessException.class);

        assertThatThrownBy(() -> inTenant(alice.user().id(), alice.workspace().id(),
                () -> jdbc.update("""
                        INSERT INTO file.upload_parts
                               (upload_id, workspace_id, part_no, sha256, size_bytes)
                        VALUES (?, ?, 99, repeat('a', 64), 1)
                        """, uploadId, bob.workspace().id())))
                .isInstanceOf(DataAccessException.class);

        assertThatThrownBy(() -> inTenant(alice.user().id(), alice.workspace().id(),
                () -> jdbc.update("UPDATE file.attachments SET workspace_id = ? WHERE id = ?",
                        bob.workspace().id(), attachmentId)))
                .isInstanceOf(DataAccessException.class);

        assertThat(migrator().queryForObject(
                "SELECT workspace_id FROM file.attachments WHERE id = ?", UUID.class,
                attachmentId)).isEqualTo(alice.workspace().id());
    }
}
