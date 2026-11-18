package ru.krug.backend.support;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MvcResult;

import ru.krug.backend.file.domain.model.FileSize;
import ru.krug.backend.file.domain.model.Sha256;
import ru.krug.backend.ops.api.dto.SessionResponse;

/** Shared E4-B HTTP helpers: preflight/init/parts/complete/abort/download/send. */
public abstract class FileUploadTestSupport extends IntegrationTestBase {

    @Autowired
    protected ru.krug.backend.file.application.port.ObjectStoragePort objectStorage;

    protected MvcResult limits(SessionResponse session, UUID workspaceId) throws Exception {
        return mockMvc.perform(authed(get("/api/v1/workspaces/{workspaceId}/limits",
                workspaceId), session)).andReturn();
    }

    protected JsonNode limitsJson(SessionResponse session, UUID workspaceId) throws Exception {
        MvcResult result = limits(session, workspaceId);
        assertThat(result.getResponse().getStatus()).isEqualTo(200);
        return json(result);
    }

    protected MvcResult preflight(SessionResponse session, UUID chatId,
                                  List<Map<String, Object>> files,
                                  String idempotencyKey) throws Exception {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("chat_id", chatId.toString());
        body.put("files", files);
        return mockMvc.perform(authed(post("/api/v1/uploads/preflight"), session)
                .header("Idempotency-Key", idempotencyKey)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(body))).andReturn();
    }

    protected MvcResult preflight(SessionResponse session, UUID chatId,
                                  List<Map<String, Object>> files) throws Exception {
        return preflight(session, chatId, files, UUID.randomUUID().toString());
    }

    protected Map<String, Object> file(String name, long size, String mime) {
        Map<String, Object> file = new LinkedHashMap<>();
        file.put("name", name);
        file.put("size", size);
        if (mime != null) {
            file.put("mime", mime);
        }
        return file;
    }

    protected MvcResult init(SessionResponse session, UUID chatId, String filename, byte[] data,
                             String mime) throws Exception {
        return init(session, chatId, filename, data, mime, UUID.randomUUID().toString());
    }

    protected MvcResult init(SessionResponse session, UUID chatId, String filename, byte[] data,
                             String mime, String idempotencyKey) throws Exception {
        return init(session, chatId, filename, data, mime, null, "MANAGED", idempotencyKey);
    }

    /** D1-BE2: optional sanitized client media metadata travels with the upload init. */
    protected MvcResult init(SessionResponse session, UUID chatId, String filename, byte[] data,
                             String mime, Map<String, Object> media) throws Exception {
        return init(session, chatId, filename, data, mime, media, "MANAGED",
                UUID.randomUUID().toString());
    }

    protected MvcResult init(SessionResponse session, UUID chatId, String filename, byte[] data,
                             String mime, Map<String, Object> media, String encryptionMode,
                             String idempotencyKey) throws Exception {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("chat_id", chatId.toString());
        body.put("filename", filename);
        body.put("size", data.length);
        if (mime != null) {
            body.put("mime", mime);
        }
        body.put("encryption_mode", encryptionMode);
        body.put("sha256", Sha256.ofBytes(data).value());
        if (media != null) {
            body.put("media", media);
        }
        return mockMvc.perform(authed(post("/api/v1/uploads"), session)
                .header("Idempotency-Key", idempotencyKey)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(body))).andReturn();
    }

    protected JsonNode initOk(SessionResponse session, UUID chatId, String filename, byte[] data,
                              String mime) throws Exception {
        MvcResult result = init(session, chatId, filename, data, mime);
        assertThat(result.getResponse().getStatus()).as(result.getResponse().getContentAsString())
                .isEqualTo(201);
        return json(result);
    }

    protected MvcResult putPart(SessionResponse session, UUID uploadId, int partNo, byte[] data,
                                String declaredSha) throws Exception {
        return mockMvc.perform(authed(put("/api/v1/uploads/{uploadId}/parts/{partNo}",
                        uploadId, partNo), session)
                .header("Content-SHA256", declaredSha)
                .contentType(MediaType.APPLICATION_OCTET_STREAM)
                .content(data)).andReturn();
    }

    protected MvcResult putPart(SessionResponse session, UUID uploadId, int partNo,
                                byte[] data) throws Exception {
        return putPart(session, uploadId, partNo, data, Sha256.ofBytes(data).value());
    }

    protected MvcResult complete(SessionResponse session, UUID uploadId, String sha256,
                                 int partsCount) throws Exception {
        return complete(session, uploadId, sha256, partsCount, UUID.randomUUID().toString());
    }

    protected MvcResult complete(SessionResponse session, UUID uploadId, String sha256,
                                 int partsCount, String idempotencyKey) throws Exception {
        return mockMvc.perform(authed(post("/api/v1/uploads/{uploadId}/complete", uploadId),
                        session)
                .header("Idempotency-Key", idempotencyKey)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(Map.of(
                        "sha256", sha256, "parts_count", partsCount)))).andReturn();
    }

    protected MvcResult abort(SessionResponse session, UUID uploadId) throws Exception {
        return mockMvc.perform(authed(post("/api/v1/uploads/{uploadId}/abort", uploadId),
                        session)
                .header("Idempotency-Key", UUID.randomUUID().toString())).andReturn();
    }

    protected MvcResult getUpload(SessionResponse session, UUID uploadId) throws Exception {
        return mockMvc.perform(authed(get("/api/v1/uploads/{uploadId}", uploadId), session))
                .andReturn();
    }

    protected MvcResult downloadUrl(SessionResponse session, UUID attachmentId) throws Exception {
        return mockMvc.perform(authed(get("/api/v1/attachments/{attachmentId}/download-url",
                attachmentId), session)).andReturn();
    }

    /** Uploads all parts, completes, and waits for the AV scheduler to leave SCANNING. */
    protected JsonNode uploadFile(SessionResponse session, UUID chatId, String filename,
                                  byte[] data, String mime) throws Exception {
        JsonNode init = initOk(session, chatId, filename, data, mime);
        UUID uploadId = UUID.fromString(init.get("upload_id").asText());
        int partSize = init.get("part_size").asInt();
        int totalParts = init.get("total_parts").asInt();
        assertThat(partSize).isEqualTo(FileSize.DEFAULT_PART_SIZE);
        for (int partNo = 1; partNo <= totalParts; partNo++) {
            int from = (partNo - 1) * partSize;
            int to = Math.min(data.length, from + partSize);
            byte[] part = java.util.Arrays.copyOfRange(data, from, to);
            MvcResult partResult = putPart(session, uploadId, partNo, part);
            assertThat(partResult.getResponse().getStatus())
                    .as(partResult.getResponse().getContentAsString()).isEqualTo(200);
        }
        MvcResult complete = complete(session, uploadId, Sha256.ofBytes(data).value(),
                totalParts);
        assertThat(complete.getResponse().getStatus())
                .as(complete.getResponse().getContentAsString()).isEqualTo(202);
        JsonNode sessionNode = json(complete);
        UUID attachmentId = UUID.fromString(sessionNode.get("attachment_id").asText());
        awaitScan(session, attachmentId, 200);
        return sessionNode;
    }

    protected int awaitScan(SessionResponse session, UUID attachmentId, int expectedStatus)
            throws Exception {
        long deadline = System.currentTimeMillis() + 8_000;
        int last = 0;
        while (System.currentTimeMillis() < deadline) {
            MvcResult result = downloadUrl(session, attachmentId);
            last = result.getResponse().getStatus();
            if (last == expectedStatus) {
                return last;
            }
            Thread.sleep(50);
        }
        return last;
    }

    protected MvcResult sendWithAttachments(SessionResponse session, UUID chatId, String text,
                                            List<UUID> attachmentIds) throws Exception {
        return sendWithAttachments(session, chatId, text, attachmentIds,
                UUID.randomUUID().toString(), UUID.randomUUID().toString());
    }

    protected MvcResult sendWithAttachments(SessionResponse session, UUID chatId, String text,
                                            List<UUID> attachmentIds, String clientMessageId,
                                            String idempotencyKey) throws Exception {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("client_message_id", clientMessageId);
        body.put("type", "TEXT");
        if (text != null) {
            body.put("text", text);
        }
        body.put("attachment_ids", attachmentIds.stream().map(UUID::toString).toList());
        return mockMvc.perform(authed(post("/api/v1/chats/{chatId}/messages", chatId), session)
                .header("Idempotency-Key", idempotencyKey)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(body))).andReturn();
    }

    protected JsonNode messages(SessionResponse session, UUID chatId) throws Exception {
        MvcResult result = mockMvc.perform(authed(
                get("/api/v1/chats/{chatId}/messages", chatId), session)).andReturn();
        assertThat(result.getResponse().getStatus()).isEqualTo(200);
        return json(result);
    }

    protected void setLimits(UUID workspaceId, long maxFileBytes, long storageBytes,
                             int maxAttachments) {
        migrator().update("""
                INSERT INTO file.workspace_limits
                       (workspace_id, tariff, max_file_bytes, storage_bytes, max_attachments,
                        guest_file_bytes, retention_months)
                VALUES (?, 'TEAM', ?, ?, ?, 524288000, 12)
                ON CONFLICT (workspace_id) DO UPDATE
                   SET tariff = 'TEAM', max_file_bytes = EXCLUDED.max_file_bytes,
                       storage_bytes = EXCLUDED.storage_bytes,
                       max_attachments = EXCLUDED.max_attachments
                """, workspaceId, maxFileBytes, storageBytes, maxAttachments);
    }

    protected Map<String, Object> usage(UUID workspaceId) {
        return migrator().queryForMap("""
                SELECT used_bytes, reserved_bytes FROM file.workspace_usage
                 WHERE workspace_id = ?
                """, workspaceId);
    }

    protected byte[] randomBytes(int size) {
        byte[] data = new byte[size];
        new java.util.Random(42).nextBytes(data);
        return data;
    }

    protected List<Map<String, Object>> files(Map<String, Object>... files) {
        return new ArrayList<>(List.of(files));
    }
}
