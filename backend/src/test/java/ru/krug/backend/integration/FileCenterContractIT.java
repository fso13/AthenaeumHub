package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

import java.util.List;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MvcResult;

import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.support.FileUploadTestSupport;
import ru.krug.backend.support.OpenApiContract;

/** Validates the #73 file-center HTTP payloads against contracts/openapi.yaml. */
@ActiveProfiles("test")
class FileCenterContractIT extends FileUploadTestSupport {

    private static final OpenApiContract CONTRACT = OpenApiContract.load();

    @Test
    void filePageAndItemsMatchTheContract() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();
        JsonNode upload = uploadFile(session, chatId, "contract-file.pdf", randomBytes(512),
                "application/pdf");
        UUID attachmentId = UUID.fromString(upload.get("attachment_id").asText());
        MvcResult send = sendWithAttachments(session, chatId, "contract", List.of(attachmentId));
        assertThat(send.getResponse().getStatus()).isEqualTo(201);

        MvcResult result = mockMvc.perform(authed(get("/api/v1/files"), session)
                .param("workspace_id", session.workspace().id().toString())).andReturn();
        assertThat(result.getResponse().getStatus()).isEqualTo(200);
        JsonNode page = json(result);
        CONTRACT.assertValid("FilePage", page);
        assertThat(page.get("items").size()).isEqualTo(1);
        CONTRACT.assertValid("FileItem", page.get("items").get(0));
        CONTRACT.assertValid("FileQuotaSummary", page.get("quota"));

        JsonNode item = page.get("items").get(0);
        assertThat(item.get("id").asText()).isEqualTo(attachmentId.toString());
        assertThat(item.get("chat_id").asText()).isEqualTo(chatId.toString());
        assertThat(item.get("message_id").isNull()).isFalse();
        assertThat(item.get("created_at").asText()).isNotBlank();
    }

    @Test
    void fileCenterErrorsMatchTheErrorSchema() throws Exception {
        SessionResponse session = devSession();

        MvcResult badLimit = mockMvc.perform(authed(get("/api/v1/files"), session)
                        .param("workspace_id", session.workspace().id().toString())
                        .param("limit", "500"))
                .andReturn();
        assertThat(badLimit.getResponse().getStatus()).isEqualTo(400);
        CONTRACT.assertValid("Error", json(badLimit));
        assertThat(json(badLimit).get("code").asText()).isEqualTo("VALIDATION_FAILED");

        MvcResult foreignChat = mockMvc.perform(authed(get("/api/v1/files"), session)
                        .param("chat_id", UUID.randomUUID().toString()))
                .andReturn();
        assertThat(foreignChat.getResponse().getStatus()).isEqualTo(404);
        CONTRACT.assertValid("Error", json(foreignChat));
        assertThat(json(foreignChat).get("code").asText()).isEqualTo("NOT_FOUND");
    }
}
