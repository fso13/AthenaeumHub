package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
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
class FilePreflightIT extends FileUploadTestSupport {

    @Test
    void limitsEndpointReturnsTransportContract() throws Exception {
        SessionResponse session = devSession();
        JsonNode limits = limitsJson(session, session.workspace().id());
        assertThat(limits.get("tariff").asText()).isEqualTo("TEAM");
        assertThat(limits.get("max_file_bytes").asLong()).isEqualTo(2L * 1024 * 1024 * 1024);
        assertThat(limits.get("storage_bytes").asLong()).isEqualTo(1024L * 1024 * 1024 * 1024);
        assertThat(limits.get("max_attachments").asInt()).isEqualTo(10);
        assertThat(limits.get("guest_file_bytes").asLong()).isEqualTo(500L * 1024 * 1024);
        assertThat(limits.get("usage").get("used").asLong()).isZero();
        assertThat(limits.get("usage").get("reserved").asLong()).isZero();
        assertThat(limits.get("usage").get("limit").asLong())
                .isEqualTo(1024L * 1024 * 1024 * 1024);
    }

    @Test
    void preflightAllowsValidFileBeforeAnyBytes() throws Exception {
        SessionResponse session = devSession();
        MvcResult result = preflight(session, session.chat().id(),
                List.of(file("atlas.pdf", 2_000_000, "application/pdf")));
        assertThat(result.getResponse().getStatus()).isEqualTo(200);
        JsonNode body = json(result);
        assertThat(body.get("decision").asText()).isEqualTo("ALLOW");
        assertThat(body.get("files").get(0).get("allowed").asBoolean()).isTrue();
        assertThat(body.get("files").get(0).get("part_size").asInt())
                .isEqualTo(8 * 1024 * 1024);
        assertThat(body.get("files").get(0).get("error").isNull()).isTrue();
        assertThat(body.get("quota").get("used").asLong()).isZero();
    }

    @Test
    void preflightDeniesOversizedFileAndInitReturns413() throws Exception {
        SessionResponse session = devSession();
        UUID workspaceId = session.workspace().id();
        setLimits(workspaceId, 1000, 1_000_000, 10);

        JsonNode preflight = json(preflight(session, session.chat().id(),
                List.of(file("big.bin", 2000, "application/octet-stream"))));
        assertThat(preflight.get("decision").asText()).isEqualTo("DENY");
        assertThat(preflight.get("files").get(0).get("error").asText())
                .isEqualTo("FILE_TOO_LARGE");
        assertThat(preflight.get("files").get(0).get("details").get("limit").asLong())
                .isEqualTo(1000);

        byte[] data = randomBytes(2000);
        MvcResult init = init(session, session.chat().id(), "big.bin", data,
                "application/octet-stream");
        assertThat(init.getResponse().getStatus()).isEqualTo(413);
        assertThat(json(init).get("code").asText()).isEqualTo("FILE_TOO_LARGE");
    }

    @Test
    void preflightDeniesQuotaPerFileAndAllowsTheRest() throws Exception {
        SessionResponse session = devSession();
        setLimits(session.workspace().id(), 1_000_000, 1000, 10);

        JsonNode body = json(preflight(session, session.chat().id(), List.of(
                file("one.bin", 600, "application/octet-stream"),
                file("two.bin", 600, "application/octet-stream"))));

        assertThat(body.get("decision").asText()).isEqualTo("DENY");
        assertThat(body.get("files").get(0).get("allowed").asBoolean()).isTrue();
        assertThat(body.get("files").get(1).get("allowed").asBoolean()).isFalse();
        assertThat(body.get("files").get(1).get("error").asText()).isEqualTo("QUOTA_EXCEEDED");
        assertThat(body.get("files").get(1).get("details").get("limit").asLong())
                .isEqualTo(1000);
        assertThat(body.get("files").get(1).get("details").get("used").asLong()).isZero();
    }

    @Test
    void preflightRejectsElevenFilesWith422() throws Exception {
        SessionResponse session = devSession();
        List<Map<String, Object>> files = new ArrayList<>();
        for (int i = 0; i < 11; i++) {
            files.add(file("f" + i + ".txt", 10, "text/plain"));
        }
        MvcResult result = preflight(session, session.chat().id(), files);
        assertThat(result.getResponse().getStatus()).isEqualTo(422);
        assertThat(json(result).get("code").asText()).isEqualTo("TOO_MANY_FILES");
    }

    @Test
    void preflightEnforcesTypePolicyPerFile() throws Exception {
        SessionResponse session = devSession();
        JsonNode body = json(preflight(session, session.chat().id(), List.of(
                file("installer.exe", 100, "application/octet-stream"),
                file("unknown.bin", 100, "application/x-unknown"),
                file("ok.txt", 100, "text/plain"))));

        assertThat(body.get("decision").asText()).isEqualTo("DENY");
        assertThat(body.get("files").get(0).get("error").asText())
                .isEqualTo("DANGEROUS_TYPE_BLOCKED");
        assertThat(body.get("files").get(1).get("error").asText())
                .isEqualTo("UNSUPPORTED_TYPE");
        assertThat(body.get("files").get(2).get("allowed").asBoolean()).isTrue();
    }

    @Test
    void initRejectsDangerousAndUnsupportedTypes() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();
        byte[] data = randomBytes(16);

        Map<String, Object> exeBody = new java.util.LinkedHashMap<>();
        exeBody.put("chat_id", chatId.toString());
        exeBody.put("filename", "installer.exe");
        exeBody.put("size", data.length);
        exeBody.put("mime", "application/octet-stream");
        exeBody.put("encryption_mode", "MANAGED");
        exeBody.put("sha256", Sha256.ofBytes(data).value());
        MvcResult exe = mockMvc.perform(authed(
                        org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                                .post("/api/v1/uploads"), session)
                        .header("Idempotency-Key", UUID.randomUUID().toString())
                        .contentType(org.springframework.http.MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(exeBody))).andReturn();
        assertThat(exe.getResponse().getStatus()).isEqualTo(422);
        assertThat(json(exe).get("code").asText()).isEqualTo("DANGEROUS_TYPE_BLOCKED");

        Map<String, Object> unsupportedBody = new java.util.LinkedHashMap<>(exeBody);
        unsupportedBody.put("filename", "unknown.bin");
        unsupportedBody.put("mime", "application/x-unknown");
        MvcResult unsupported = mockMvc.perform(authed(
                        org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                                .post("/api/v1/uploads"), session)
                        .header("Idempotency-Key", UUID.randomUUID().toString())
                        .contentType(org.springframework.http.MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(unsupportedBody))).andReturn();
        assertThat(unsupported.getResponse().getStatus()).isEqualTo(415);
        assertThat(json(unsupported).get("code").asText()).isEqualTo("UNSUPPORTED_TYPE");
    }

    @Test
    void initRejectsE2eeEncryptionMode() throws Exception {
        SessionResponse session = devSession();
        byte[] data = randomBytes(16);
        Map<String, Object> body = new java.util.LinkedHashMap<>();
        body.put("chat_id", session.chat().id().toString());
        body.put("filename", "secret.bin");
        body.put("size", data.length);
        body.put("mime", "application/octet-stream");
        body.put("encryption_mode", "E2EE");
        body.put("sha256", Sha256.ofBytes(data).value());
        MvcResult result = mockMvc.perform(authed(
                        org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                                .post("/api/v1/uploads"), session)
                        .header("Idempotency-Key", UUID.randomUUID().toString())
                        .contentType(org.springframework.http.MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(body))).andReturn();
        assertThat(result.getResponse().getStatus()).isEqualTo(422);
        assertThat(json(result).get("code").asText()).isEqualTo("MODE_NOT_SUPPORTED");
    }

    @Test
    void guestUsesGuestFileLimit() throws Exception {
        SessionResponse session = devSession();
        UUID workspaceId = session.workspace().id();
        migrator().update("UPDATE workspace.memberships SET role = 'GUEST'"
                + " WHERE workspace_id = ? AND user_id = ?", workspaceId, session.user().id());

        JsonNode limits = limitsJson(session, workspaceId);
        assertThat(limits.get("guest_file_bytes").asLong())
                .isEqualTo(500L * 1024 * 1024);
        assertThat(limits.get("max_file_bytes").asLong())
                .isEqualTo(2L * 1024 * 1024 * 1024);

        JsonNode body = json(preflight(session, session.chat().id(),
                List.of(file("movie.mkv", 600L * 1024 * 1024, "video/x-matroska"))));
        assertThat(body.get("files").get(0).get("error").asText()).isEqualTo("FILE_TOO_LARGE");
        assertThat(body.get("files").get(0).get("details").get("limit").asLong())
                .isEqualTo(500L * 1024 * 1024);
        assertThat(body.get("max_file_bytes").asLong()).isEqualTo(500L * 1024 * 1024);
    }
}
