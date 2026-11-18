package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MvcResult;

import ru.krug.backend.file.domain.model.Sha256;
import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.support.FileUploadTestSupport;
import ru.krug.backend.support.OpenApiContract;

/** Validates the E4-B HTTP responses against contracts/openapi.yaml components. */
@ActiveProfiles("test")
class FileContractIT extends FileUploadTestSupport {

    private static final OpenApiContract CONTRACT = OpenApiContract.load();

    @Test
    void limitsPreflightUploadPartCompleteDownloadAndMessageMatchTheContract() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();
        byte[] data = randomBytes(256);
        String sha = Sha256.ofBytes(data).value();

        MvcResult limits = limits(session, session.workspace().id());
        assertThat(limits.getResponse().getStatus()).isEqualTo(200);
        CONTRACT.assertValid("WorkspaceLimits", json(limits));

        MvcResult preflight = preflight(session, chatId,
                List.of(file("contract.txt", data.length, "text/plain")));
        CONTRACT.assertValid("PreflightResponse", json(preflight));

        Map<String, Object> initBody = new LinkedHashMap<>();
        initBody.put("chat_id", chatId.toString());
        initBody.put("filename", "contract.txt");
        initBody.put("size", data.length);
        initBody.put("mime", "text/plain");
        initBody.put("encryption_mode", "MANAGED");
        initBody.put("sha256", sha);
        MvcResult init = mockMvc.perform(authed(post("/api/v1/uploads"), session)
                        .header("Idempotency-Key", UUID.randomUUID().toString())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(initBody)))
                .andExpect(status().isCreated()).andReturn();
        CONTRACT.assertValid("UploadSession", json(init));
        UUID uploadId = UUID.fromString(json(init).get("upload_id").asText());

        MvcResult put = mockMvc.perform(authed(
                        put("/api/v1/uploads/{uploadId}/parts/1", uploadId), session)
                        .header("Content-SHA256", sha)
                        .contentType(MediaType.APPLICATION_OCTET_STREAM)
                        .content(data)).andExpect(status().isOk()).andReturn();
        CONTRACT.assertValid("UploadPart", json(put));

        MvcResult getUpload = mockMvc.perform(authed(
                        get("/api/v1/uploads/{uploadId}", uploadId), session))
                .andExpect(status().isOk()).andReturn();
        CONTRACT.assertValid("UploadSession", json(getUpload));

        MvcResult complete = complete(session, uploadId, sha, 1);
        assertThat(complete.getResponse().getStatus()).isEqualTo(202);
        CONTRACT.assertValid("UploadSession", json(complete));
        UUID attachmentId = UUID.fromString(json(complete).get("attachment_id").asText());

        assertThat(awaitScan(session, attachmentId, 200)).isEqualTo(200);
        MvcResult download = downloadUrl(session, attachmentId);
        CONTRACT.assertValid("DownloadUrl", json(download));

        MvcResult send = sendWithAttachments(session, chatId, "contract",
                List.of(attachmentId));
        assertThat(send.getResponse().getStatus()).isEqualTo(201);
        JsonNode message = json(send);
        CONTRACT.assertValid("Message", message);
        assertThat(message.get("attachments").size()).isEqualTo(1);
    }

    @Test
    void quarantinedDownloadErrorMatchesErrorSchema() throws Exception {
        SessionResponse session = devSession();
        byte[] data = randomBytes(64);
        JsonNode init = initOk(session, session.chat().id(), "infected-contract.txt", data,
                "text/plain");
        UUID uploadId = UUID.fromString(init.get("upload_id").asText());
        assertThat(putPart(session, uploadId, 1, data).getResponse().getStatus()).isEqualTo(200);
        MvcResult complete = complete(session, uploadId, Sha256.ofBytes(data).value(), 1);
        UUID attachmentId = UUID.fromString(json(complete).get("attachment_id").asText());
        assertThat(awaitScan(session, attachmentId, 423)).isEqualTo(423);

        MvcResult download = downloadUrl(session, attachmentId);
        assertThat(download.getResponse().getStatus()).isEqualTo(423);
        CONTRACT.assertValid("Error", json(download));

        MvcResult state = getUpload(session, uploadId);
        assertThat(state.getResponse().getStatus()).isEqualTo(200);
        assertThat(json(state).get("status").asText()).isEqualTo("QUARANTINED");
        CONTRACT.assertValid("UploadSession", json(state));
    }
}
