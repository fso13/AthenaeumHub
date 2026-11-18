package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MvcResult;

import ru.krug.backend.file.domain.model.Sha256;
import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.support.FileUploadTestSupport;

@ActiveProfiles("test")
class FileUploadIT extends FileUploadTestSupport {

    @Test
    void uploadsChunksCompletesScansAndDownloads() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();
        byte[] data = randomBytes(8 * 1024 * 1024 + 10);

        JsonNode init = initOk(session, chatId, "atlas.bin", data, "application/octet-stream");
        UUID uploadId = UUID.fromString(init.get("upload_id").asText());
        assertThat(init.get("status").asText()).isEqualTo("INIT");
        assertThat(init.get("part_size").asInt()).isEqualTo(8 * 1024 * 1024);
        assertThat(init.get("total_parts").asInt()).isEqualTo(2);
        assertThat(init.get("expires_at").asText()).isNotBlank();

        for (int partNo = 1; partNo <= 2; partNo++) {
            int from = (partNo - 1) * 8 * 1024 * 1024;
            byte[] part = java.util.Arrays.copyOfRange(data, from,
                    Math.min(data.length, from + 8 * 1024 * 1024));
            MvcResult put = putPart(session, uploadId, partNo, part);
            assertThat(put.getResponse().getStatus()).isEqualTo(200);
            assertThat(json(put).get("received").asBoolean()).isTrue();
        }

        MvcResult complete = complete(session, uploadId, Sha256.ofBytes(data).value(), 2);
        assertThat(complete.getResponse().getStatus()).isEqualTo(202);
        JsonNode completed = json(complete);
        assertThat(completed.get("status").asText()).isEqualTo("SCANNING");
        UUID attachmentId = UUID.fromString(completed.get("attachment_id").asText());

        assertThat(awaitScan(session, attachmentId, 200)).isEqualTo(200);
        MvcResult download = downloadUrl(session, attachmentId);
        assertThat(download.getResponse().getStatus()).isEqualTo(200);
        JsonNode url = json(download);
        assertThat(url.get("url").asText()).startsWith("memory://krug/");
        assertThat(url.get("size_bytes").asLong()).isEqualTo(data.length);
        assertThat(url.get("sha256").asText()).isEqualTo(Sha256.ofBytes(data).value());
        assertThat(url.get("expires_at").asText()).isNotBlank();

        JsonNode upload = json(getUpload(session, uploadId));
        assertThat(upload.get("status").asText()).isEqualTo("READY");
        assertThat(upload.get("received_parts").size()).isEqualTo(2);
    }

    @Test
    void chunkRetryIsIdempotentAndConflictsOnDifferentHash() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();
        byte[] data = randomBytes(8 * 1024 * 1024 + 10);
        JsonNode init = initOk(session, chatId, "chunks.bin", data, "application/octet-stream");
        UUID uploadId = UUID.fromString(init.get("upload_id").asText());
        byte[] part1 = java.util.Arrays.copyOfRange(data, 0, 8 * 1024 * 1024);
        byte[] part2 = java.util.Arrays.copyOfRange(data, 8 * 1024 * 1024, data.length);

        MvcResult first = putPart(session, uploadId, 1, part1);
        assertThat(first.getResponse().getStatus()).isEqualTo(200);
        String etag = json(first).get("etag").asText();

        MvcResult repeat = putPart(session, uploadId, 1, part1);
        assertThat(repeat.getResponse().getStatus()).isEqualTo(200);
        assertThat(json(repeat).get("etag").asText()).isEqualTo(etag);

        MvcResult badHash = putPart(session, uploadId, 1, part1,
                Sha256.ofBytes(part2).value());
        assertThat(badHash.getResponse().getStatus()).isEqualTo(422);
        assertThat(json(badHash).get("code").asText()).isEqualTo("CHUNK_HASH_MISMATCH");

        byte[] other = part1.clone();
        other[0] ^= 0x7f;
        MvcResult conflict = putPart(session, uploadId, 1, other,
                Sha256.ofBytes(other).value());
        assertThat(conflict.getResponse().getStatus()).isEqualTo(409);
        assertThat(json(conflict).get("code").asText()).isEqualTo("CHUNK_CONFLICT");

        MvcResult wrongSize = putPart(session, uploadId, 1, part2);
        assertThat(wrongSize.getResponse().getStatus()).isEqualTo(422);
        assertThat(json(wrongSize).get("code").asText()).isEqualTo("CHUNK_SIZE_MISMATCH");

        assertThat(putPart(session, uploadId, 2, part2).getResponse().getStatus()).isEqualTo(200);
        MvcResult complete = complete(session, uploadId, Sha256.ofBytes(data).value(), 2);
        assertThat(complete.getResponse().getStatus()).isEqualTo(202);
    }

    @Test
    void resumeReturnsReceivedAndMissingParts() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();
        byte[] data = randomBytes(8 * 1024 * 1024 + 10);
        JsonNode init = initOk(session, chatId, "resume.bin", data, "application/octet-stream");
        UUID uploadId = UUID.fromString(init.get("upload_id").asText());
        byte[] part1 = java.util.Arrays.copyOfRange(data, 0, 8 * 1024 * 1024);

        assertThat(putPart(session, uploadId, 1, part1).getResponse().getStatus()).isEqualTo(200);

        JsonNode state = json(getUpload(session, uploadId));
        assertThat(state.get("status").asText()).isEqualTo("UPLOADING");
        assertThat(state.get("received_parts").size()).isEqualTo(1);
        assertThat(state.get("received_parts").get(0).asInt()).isEqualTo(1);

        MvcResult incomplete = complete(session, uploadId, Sha256.ofBytes(data).value(), 1);
        assertThat(incomplete.getResponse().getStatus()).isEqualTo(422);
        JsonNode error = json(incomplete);
        assertThat(error.get("code").asText()).isEqualTo("INCOMPLETE_UPLOAD");
        assertThat(error.get("details").get("missing_parts").get(0).asInt()).isEqualTo(2);
    }

    @Test
    void completeRejectsWrongWholeFileHashAndPartsCount() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();
        byte[] data = randomBytes(512);
        JsonNode init = initOk(session, chatId, "hash.bin", data, "application/octet-stream");
        UUID uploadId = UUID.fromString(init.get("upload_id").asText());
        assertThat(putPart(session, uploadId, 1, data).getResponse().getStatus()).isEqualTo(200);

        MvcResult wrongCount = complete(session, uploadId, Sha256.ofBytes(data).value(), 2);
        assertThat(wrongCount.getResponse().getStatus()).isEqualTo(422);
        assertThat(json(wrongCount).get("code").asText()).isEqualTo("INCOMPLETE_UPLOAD");

        MvcResult wrongHash = complete(session, uploadId,
                Sha256.ofBytes("different".getBytes()).value(), 1);
        assertThat(wrongHash.getResponse().getStatus()).isEqualTo(422);
        assertThat(json(wrongHash).get("code").asText()).isEqualTo("FILE_HASH_MISMATCH");

        MvcResult ok = complete(session, uploadId, Sha256.ofBytes(data).value(), 1);
        assertThat(ok.getResponse().getStatus()).isEqualTo(202);
    }

    @Test
    void abortReleasesReservationAndIsIdempotent() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();
        byte[] data = randomBytes(1024);
        UUID workspaceId = session.workspace().id();
        JsonNode init = initOk(session, chatId, "abort.bin", data, "application/octet-stream");
        UUID uploadId = UUID.fromString(init.get("upload_id").asText());

        assertThat(((Number) usage(workspaceId).get("reserved_bytes")).longValue())
                .isEqualTo(1024);
        assertThat(abort(session, uploadId).getResponse().getStatus()).isEqualTo(204);
        assertThat(((Number) usage(workspaceId).get("reserved_bytes")).longValue()).isZero();
        assertThat(abort(session, uploadId).getResponse().getStatus()).isEqualTo(204);

        JsonNode state = json(getUpload(session, uploadId));
        assertThat(state.get("status").asText()).isEqualTo("ABORTED");
    }

    @Test
    void completeCommitsReservedToUsedExactlyOnce() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();
        UUID workspaceId = session.workspace().id();
        byte[] data = randomBytes(2048);
        JsonNode init = initOk(session, chatId, "commit.bin", data, "application/octet-stream");
        UUID uploadId = UUID.fromString(init.get("upload_id").asText());
        assertThat(((Number) usage(workspaceId).get("reserved_bytes")).longValue())
                .isEqualTo(2048);

        assertThat(putPart(session, uploadId, 1, data).getResponse().getStatus()).isEqualTo(200);
        MvcResult complete = complete(session, uploadId, Sha256.ofBytes(data).value(), 1);
        assertThat(complete.getResponse().getStatus()).isEqualTo(202);
        UUID attachmentId = UUID.fromString(json(complete).get("attachment_id").asText());

        Map<String, Object> afterComplete = usage(workspaceId);
        assertThat(((Number) afterComplete.get("used_bytes")).longValue()).isEqualTo(2048);
        assertThat(((Number) afterComplete.get("reserved_bytes")).longValue()).isZero();

        // Repeated complete must not move quota again.
        MvcResult replay = complete(session, uploadId, Sha256.ofBytes(data).value(), 1);
        // The AV scheduler may already have moved SCANNING -> READY; both are valid replay
        // outcomes and neither may touch quota again.
        assertThat(replay.getResponse().getStatus()).isIn(200, 202);
        Map<String, Object> afterReplay = usage(workspaceId);
        assertThat(((Number) afterReplay.get("used_bytes")).longValue()).isEqualTo(2048);
        assertThat(((Number) afterReplay.get("reserved_bytes")).longValue()).isZero();

        assertThat(awaitScan(session, attachmentId, 200)).isEqualTo(200);
        Map<String, Object> afterScan = usage(workspaceId);
        assertThat(((Number) afterScan.get("used_bytes")).longValue()).isEqualTo(2048);
    }

    @Test
    void infectedFileIsQuarantinedAndQuotaReleased() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();
        UUID workspaceId = session.workspace().id();
        byte[] data = randomBytes(4096);
        JsonNode init = initOk(session, chatId, "infected.bin", data,
                "application/octet-stream");
        UUID uploadId = UUID.fromString(init.get("upload_id").asText());
        assertThat(putPart(session, uploadId, 1, data).getResponse().getStatus()).isEqualTo(200);
        MvcResult complete = complete(session, uploadId, Sha256.ofBytes(data).value(), 1);
        assertThat(complete.getResponse().getStatus()).isEqualTo(202);
        UUID attachmentId = UUID.fromString(json(complete).get("attachment_id").asText());

        assertThat(awaitScan(session, attachmentId, 423)).isEqualTo(423);
        MvcResult download = downloadUrl(session, attachmentId);
        assertThat(download.getResponse().getStatus()).isEqualTo(423);
        assertThat(json(download).get("code").asText()).isEqualTo("ATTACHMENT_QUARANTINED");

        JsonNode upload = json(getUpload(session, uploadId));
        assertThat(upload.get("status").asText()).isEqualTo("QUARANTINED");
        Map<String, Object> usage = usage(workspaceId);
        assertThat(((Number) usage.get("used_bytes")).longValue()).isZero();
        assertThat(((Number) usage.get("reserved_bytes")).longValue()).isZero();
    }

    @Test
    void initFailsWhenWorkspaceQuotaIsExhausted() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();
        setLimits(session.workspace().id(), 1000, 100, 10);

        byte[] data = randomBytes(60);
        assertThat(init(session, chatId, "first.bin", data, "application/octet-stream")
                .getResponse().getStatus()).isEqualTo(201);

        MvcResult second = init(session, chatId, "second.bin", data,
                "application/octet-stream");
        assertThat(second.getResponse().getStatus()).isEqualTo(409);
        JsonNode error = json(second);
        assertThat(error.get("code").asText()).isEqualTo("QUOTA_EXCEEDED");
        assertThat(error.get("details").get("limit").asLong()).isEqualTo(100);
    }

    @Test
    void initIdempotencyKeyReplaysTheSameUpload() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();
        UUID workspaceId = session.workspace().id();
        byte[] data = randomBytes(128);
        String key = UUID.randomUUID().toString();

        MvcResult first = init(session, chatId, "idem.bin", data, "text/plain", key);
        assertThat(first.getResponse().getStatus()).isEqualTo(201);
        UUID uploadId = UUID.fromString(json(first).get("upload_id").asText());
        long reserved = ((Number) usage(workspaceId).get("reserved_bytes")).longValue();
        assertThat(reserved).isEqualTo(128);

        MvcResult replay = init(session, chatId, "idem.bin", data, "text/plain", key);
        assertThat(replay.getResponse().getStatus()).isEqualTo(201);
        assertThat(json(replay).get("upload_id").asText()).isEqualTo(uploadId.toString());
        assertThat(((Number) usage(workspaceId).get("reserved_bytes")).longValue())
                .isEqualTo(128);

        byte[] other = randomBytes(64);
        MvcResult conflict = init(session, chatId, "idem.bin", other, "text/plain", key);
        assertThat(conflict.getResponse().getStatus()).isEqualTo(409);
        assertThat(json(conflict).get("code").asText()).isEqualTo("IDEMPOTENCY_KEY_REUSED");
    }

    @Test
    void uploadPartIsHiddenFromAnotherTenant() throws Exception {
        SessionResponse alice = devSession();
        SessionResponse bob = devSession();
        byte[] data = randomBytes(64);
        JsonNode init = initOk(alice, alice.chat().id(), "private.bin", data, "text/plain");
        UUID uploadId = UUID.fromString(init.get("upload_id").asText());

        assertThat(getUpload(bob, uploadId).getResponse().getStatus()).isEqualTo(404);
        assertThat(putPart(bob, uploadId, 1, data).getResponse().getStatus()).isEqualTo(404);
        assertThat(complete(bob, uploadId, Sha256.ofBytes(data).value(), 1)
                .getResponse().getStatus()).isEqualTo(404);
    }

    @Test
    void listAndGetRejectMissingIdempotencyHeaders() throws Exception {
        SessionResponse session = devSession();
        byte[] data = randomBytes(16);
        Map<String, Object> body = Map.of("chat_id", session.chat().id().toString(),
                "filename", "x.txt", "size", data.length, "encryption_mode", "MANAGED");
        MvcResult result = mockMvc.perform(authed(
                        org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                                .post("/api/v1/uploads"), session)
                        .contentType(org.springframework.http.MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(body))).andReturn();
        assertThat(result.getResponse().getStatus()).isEqualTo(400);
        assertThat(json(result).get("code").asText()).isEqualTo("VALIDATION_FAILED");
    }
}
