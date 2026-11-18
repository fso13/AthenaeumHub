package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MvcResult;

import ru.krug.backend.file.domain.model.Sha256;
import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.support.FileUploadTestSupport;

@ActiveProfiles("test")
class FileMessageIT extends FileUploadTestSupport {

    @Test
    void sendsMessageWithCleanAttachmentAndCommitsQuotaOnce() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();
        UUID workspaceId = session.workspace().id();
        byte[] data = randomBytes(4096);
        JsonNode upload = uploadFile(session, chatId, "report.pdf", data, "application/pdf");
        UUID attachmentId = UUID.fromString(upload.get("attachment_id").asText());

        MvcResult send = sendWithAttachments(session, chatId, "with file",
                List.of(attachmentId));
        assertThat(send.getResponse().getStatus())
                .as(send.getResponse().getContentAsString()).isEqualTo(201);
        JsonNode message = json(send);
        assertThat(message.get("attachments").size()).isEqualTo(1);
        assertThat(message.get("attachments").get(0).get("id").asText())
                .isEqualTo(attachmentId.toString());
        assertThat(message.get("attachments").get(0).get("scan_status").asText())
                .isEqualTo("CLEAN");
        assertThat(message.get("attachments").get(0).get("filename").asText())
                .isEqualTo("report.pdf");
        assertThat(message.get("attachments").get(0).get("size_bytes").asLong())
                .isEqualTo(data.length);

        // Binding must not double-charge: complete already committed, bind only links.
        assertThat(((Number) usage(workspaceId).get("used_bytes")).longValue())
                .isEqualTo(data.length);
        assertThat(((Number) usage(workspaceId).get("reserved_bytes")).longValue()).isZero();

        String status = migrator().queryForObject("""
                SELECT status || ':' || scan_status FROM file.attachments WHERE id = ?
                """, String.class, attachmentId);
        assertThat(status).isEqualTo("BOUND:CLEAN");
        UUID uploadId = UUID.fromString(upload.get("upload_id").asText());
        assertThat(json(getUpload(session, uploadId)).get("status").asText()).isEqualTo("BOUND");

        JsonNode page = messages(session, chatId);
        assertThat(page.get("items").get(0).get("attachments").size()).isEqualTo(1);
        assertThat(page.get("items").get(0).get("attachments").get(0).get("id").asText())
                .isEqualTo(attachmentId.toString());
    }

    @Test
    void textIsOptionalWhenAttachmentsArePresent() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();
        byte[] data = randomBytes(256);
        JsonNode upload = uploadFile(session, chatId, "photo.png", data, "image/png");
        UUID attachmentId = UUID.fromString(upload.get("attachment_id").asText());

        MvcResult send = sendWithAttachments(session, chatId, null, List.of(attachmentId));
        assertThat(send.getResponse().getStatus()).isEqualTo(201);
        JsonNode message = json(send);
        assertThat(message.get("text").isNull()).isTrue();
        assertThat(message.get("attachments").size()).isEqualTo(1);
    }

    @Test
    void rejectsEmptyMessageAndTooManyAttachments() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();

        MvcResult empty = sendWithAttachments(session, chatId, null, List.of());
        assertThat(empty.getResponse().getStatus()).isEqualTo(400);

        List<UUID> eleven = new ArrayList<>();
        for (int i = 0; i < 11; i++) {
            eleven.add(UUID.randomUUID());
        }
        MvcResult tooMany = sendWithAttachments(session, chatId, "x", eleven);
        assertThat(tooMany.getResponse().getStatus()).isEqualTo(422);
        assertThat(json(tooMany).get("code").asText()).isEqualTo("TOO_MANY_FILES");
    }

    @Test
    void rejectsAttachmentThatIsStillScanning() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();
        byte[] data = randomBytes(256);
        JsonNode upload = uploadFile(session, chatId, "pending.txt", data, "text/plain");
        UUID attachmentId = UUID.fromString(upload.get("attachment_id").asText());
        migrator().update("UPDATE file.attachments SET scan_status = 'PENDING' WHERE id = ?",
                attachmentId);

        MvcResult send = sendWithAttachments(session, chatId, "soon",
                List.of(attachmentId));
        assertThat(send.getResponse().getStatus()).isEqualTo(409);
        assertThat(json(send).get("code").asText()).isEqualTo("ATTACHMENT_NOT_READY");
    }

    @Test
    void rejectsQuarantinedAttachmentWith423() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();
        byte[] data = randomBytes(512);
        JsonNode init = initOk(session, chatId, "infected.txt", data, "text/plain");
        UUID uploadId = UUID.fromString(init.get("upload_id").asText());
        assertThat(putPart(session, uploadId, 1, data).getResponse().getStatus()).isEqualTo(200);
        MvcResult complete = complete(session, uploadId, Sha256.ofBytes(data).value(), 1);
        UUID attachmentId = UUID.fromString(json(complete).get("attachment_id").asText());
        assertThat(awaitScan(session, attachmentId, 423)).isEqualTo(423);
        assertThat(json(getUpload(session, uploadId)).get("status").asText())
                .isEqualTo("QUARANTINED");

        MvcResult send = sendWithAttachments(session, chatId, "bad",
                List.of(attachmentId));
        assertThat(send.getResponse().getStatus()).isEqualTo(423);
        assertThat(json(send).get("code").asText()).isEqualTo("ATTACHMENT_QUARANTINED");
    }

    @Test
    void rejectsForeignAttachmentAndSecondBind() throws Exception {
        SessionResponse alice = devSession();
        SessionResponse bob = devSession();
        byte[] data = randomBytes(128);
        JsonNode upload = uploadFile(alice, alice.chat().id(), "a.txt", data, "text/plain");
        UUID attachmentId = UUID.fromString(upload.get("attachment_id").asText());

        MvcResult foreign = sendWithAttachments(bob, bob.chat().id(), "steal",
                List.of(attachmentId));
        assertThat(foreign.getResponse().getStatus()).isEqualTo(404);

        MvcResult first = sendWithAttachments(alice, alice.chat().id(), "one",
                List.of(attachmentId));
        assertThat(first.getResponse().getStatus()).isEqualTo(201);

        MvcResult second = sendWithAttachments(alice, alice.chat().id(), "two",
                List.of(attachmentId));
        assertThat(second.getResponse().getStatus()).isEqualTo(409);
        assertThat(json(second).get("code").asText()).isEqualTo("ATTACHMENT_NOT_READY");
    }

    @Test
    void idempotentMessageReplayIncludesAttachmentsAndDoesNotDoubleCharge() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();
        UUID workspaceId = session.workspace().id();
        byte[] data = randomBytes(1024);
        JsonNode upload = uploadFile(session, chatId, "replay.bin", data,
                "application/octet-stream");
        UUID attachmentId = UUID.fromString(upload.get("attachment_id").asText());
        String clientId = UUID.randomUUID().toString();
        String key = UUID.randomUUID().toString();

        MvcResult first = sendWithAttachments(session, chatId, "replay",
                List.of(attachmentId), clientId, key);
        assertThat(first.getResponse().getStatus()).isEqualTo(201);
        long used = ((Number) usage(workspaceId).get("used_bytes")).longValue();
        assertThat(used).isEqualTo(data.length);

        MvcResult replay = sendWithAttachments(session, chatId, "replay",
                List.of(attachmentId), clientId, key);
        assertThat(replay.getResponse().getStatus()).isEqualTo(201);
        assertThat(json(replay).get("id").asText()).isEqualTo(json(first).get("id").asText());
        assertThat(json(replay).get("attachments").size()).isEqualTo(1);
        assertThat(((Number) usage(workspaceId).get("used_bytes")).longValue()).isEqualTo(used);
    }
}
