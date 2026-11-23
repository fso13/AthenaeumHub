package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MvcResult;

import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.support.FileUploadTestSupport;

/**
 * #101 DLP coverage beyond message sends: attachment metadata (upload/bind), edited text,
 * poll/task payloads and translation. Every BLOCK leaves no content and only a
 * content-free event; tenant rules never leak into another workspace.
 */
@ActiveProfiles("test")
class WorkspaceDlpCoverageIT extends FileUploadTestSupport {

    @Test
    void attachmentUploadAndBindAreEvaluatedAndTheEventIsContentFree() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("dlp-file-owner"));
        UUID workspaceId = owner.workspace().id();
        UUID chatId = owner.chat().id();
        enableDlp(owner, workspaceId);
        createPolicy(owner, workspaceId, "Attachment secret", "BLOCK", "KEYWORD",
                "top-secret", "ATTACHMENT", null);

        MvcResult blocked = init(owner, chatId, "top-secret.pdf", bytes("blocked"),
                "application/pdf");
        assertDlpBlocked(blocked, "ATTACHMENT");
        assertThat(uploadCount(chatId)).isZero();

        // A clean file passes the same rule and can be uploaded.
        JsonNode uploaded = uploadFile(owner, chatId, "report.pdf", bytes("report"),
                "application/pdf");
        UUID attachmentId = UUID.fromString(uploaded.get("attachment_id").asText());

        // A rule created after the upload is re-evaluated at bind time.
        createPolicy(owner, workspaceId, "Report bind", "BLOCK", "PATTERN", "report*",
                "ATTACHMENT", null);
        MvcResult send = sendWithAttachments(owner, chatId, "document",
                List.of(attachmentId));
        assertDlpBlocked(send, "ATTACHMENT");
        assertThat(messageCount(chatId)).isZero();
        assertThat(attachmentMessageId(attachmentId)).isNull();

        JsonNode events = dlpEvents(owner, workspaceId);
        assertThat(events.get("items")).hasSize(2);
        assertThat(events.get("items")).extracting(node -> node.get("action").asText())
                .containsOnly("BLOCK");
        String raw = events.toString();
        assertThat(raw).doesNotContain("top-secret", "report.pdf", "blocked", "document");
        assertThat(dlpEventRows(workspaceId)).doesNotContain("top-secret", "report.pdf");
    }

    @Test
    void aWorkspaceRuleNeverBlocksAnotherWorkspace() throws Exception {
        SessionResponse first = devSession(uniqueDisplayName("dlp-tenant-a"));
        SessionResponse second = devSession(uniqueDisplayName("dlp-tenant-b"));
        enableDlp(first, first.workspace().id());
        createPolicy(first, first.workspace().id(), "Tenant A secret", "BLOCK", "KEYWORD",
                "top-secret", "ATTACHMENT", null);

        // The same file name is accepted by a workspace that has no matching rule.
        JsonNode other = uploadFile(second, second.chat().id(), "top-secret.pdf",
                bytes("other-tenant"), "application/pdf");
        assertThat(other.get("attachment_id").asText()).isNotBlank();
        assertThat(dlpEventCount(second.workspace().id())).isZero();
        assertThat(dlpEventCount(first.workspace().id())).isZero();
    }

    @Test
    void editedTextIsReevaluatedAndABlockKeepsTheOriginal() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("dlp-edit-owner"));
        UUID workspaceId = owner.workspace().id();
        UUID chatId = owner.chat().id();
        enableDlp(owner, workspaceId);
        JsonNode sent = sendMessage(owner, chatId, UUID.randomUUID().toString(),
                UUID.randomUUID().toString(), "hello");
        UUID messageId = UUID.fromString(sent.get("id").asText());

        createPolicy(owner, workspaceId, "Edit secret", "BLOCK", "KEYWORD", "top-secret",
                "TEXT", null);
        MvcResult blocked = edit(owner, chatId, messageId, "here is a top-secret value");
        assertDlpBlocked(blocked, "TEXT");

        JsonNode page = messages(owner, chatId);
        JsonNode unchanged = item(page, messageId);
        assertThat(unchanged.get("text").asText()).isEqualTo("hello");
        assertThat(unchanged.get("version").asInt()).isEqualTo(1);

        createPolicy(owner, workspaceId, "Edit warn", "WARN", "KEYWORD", "card-number",
                "TEXT", null);
        MvcResult warned = edit(owner, chatId, messageId, "my card-number");
        assertThat(warned.getResponse().getStatus()).isEqualTo(200);
        assertThat(json(warned).get("text").asText()).isEqualTo("my card-number");
        assertThat(json(warned).get("version").asInt()).isEqualTo(2);

        JsonNode events = dlpEvents(owner, workspaceId);
        assertThat(events.get("items")).extracting(node -> node.get("action").asText())
                .containsExactlyInAnyOrder("BLOCK", "WARN");
        assertThat(dlpEventRows(workspaceId)).doesNotContain("top-secret", "card-number");
    }

    @Test
    void pollTaskAndTranslationPayloadsAreEvaluatedBeforePersisting() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("dlp-plugin-owner"));
        UUID workspaceId = owner.workspace().id();
        UUID chatId = owner.chat().id();
        enableDlp(owner, workspaceId);
        enablePlugin(owner, chatId, "polls");
        enablePlugin(owner, chatId, "tasks");
        enablePlugin(owner, chatId, "translate");
        createPolicy(owner, workspaceId, "Plugin rule", "BLOCK", "KEYWORD", "roadmap",
                "PLUGIN", null);

        MvcResult blockedPoll = mockMvc.perform(authed(
                        post("/api/v1/chats/{chatId}/polls", chatId), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "question", "Q1 roadmap", "options", List.of("now", "later")))))
                .andReturn();
        assertDlpBlocked(blockedPoll, "PLUGIN");
        assertThat(pluginCount("plugin.polls", chatId)).isZero();
        assertThat(pluginCount("plugin.poll_options", chatId)).isZero();

        MvcResult blockedTask = mockMvc.perform(authed(
                        post("/api/v1/chats/{chatId}/tasks", chatId), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "title", "roadmap item"))))
                .andReturn();
        assertDlpBlocked(blockedTask, "PLUGIN");
        assertThat(pluginCount("plugin.tasks", chatId)).isZero();

        // A clean poll still works; the rule is scoped to plugin payloads.
        MvcResult cleanPoll = mockMvc.perform(authed(
                        post("/api/v1/chats/{chatId}/polls", chatId), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "question", "Lunch?", "options", List.of("pizza", "sushi")))))
                .andExpect(status().isCreated())
                .andReturn();
        assertThat(json(cleanPoll).get("id").asText()).isNotBlank();

        // Translation input is checked before any provider call. The message itself is
        // plain TEXT, so the PLUGIN-scoped rule does not block the send.
        JsonNode sent = sendMessage(owner, chatId, UUID.randomUUID().toString(),
                UUID.randomUUID().toString(), "the roadmap");
        MvcResult translate = mockMvc.perform(authed(post(
                        "/api/v1/chats/{chatId}/messages/{messageId}/translate", chatId,
                        UUID.fromString(sent.get("id").asText())), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("target", "en"))))
                .andReturn();
        assertDlpBlocked(translate, "PLUGIN");

        JsonNode events = dlpEvents(owner, workspaceId);
        assertThat(events.get("items")).extracting(node -> node.get("action").asText())
                .containsOnly("BLOCK");
        assertThat(events.get("items")).hasSize(3);
        assertThat(dlpEventRows(workspaceId))
                .doesNotContain("roadmap", "Q1", "Lunch", "pizza", "the roadmap");
    }

    // ------------------------------------------------------------------

    private void enableDlp(SessionResponse session, UUID workspaceId) throws Exception {
        mockMvc.perform(authed(patch("/api/v1/workspaces/{id}/security", workspaceId),
                        session)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("dlp_enabled", true))))
                .andExpect(status().isOk());
    }

    private void createPolicy(SessionResponse session, UUID workspaceId, String name,
                              String action, String type, String pattern, String scope,
                              Long maxFileSizeBytes) throws Exception {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("name", name);
        body.put("action", action);
        body.put("pattern_type", type);
        body.put("pattern", pattern);
        body.put("scope", scope);
        if (maxFileSizeBytes != null) {
            body.put("max_file_size_bytes", maxFileSizeBytes);
        }
        mockMvc.perform(authed(post("/api/v1/workspaces/{id}/dlp/policies", workspaceId),
                        session)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(body)))
                .andExpect(status().isCreated());
    }

    private void enablePlugin(SessionResponse session, UUID chatId, String pluginId)
            throws Exception {
        mockMvc.perform(authed(patch("/api/v1/chats/{chatId}/plugins/{pluginId}", chatId,
                        pluginId), session)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("enabled", true))))
                .andExpect(status().isOk());
    }

    private MvcResult edit(SessionResponse session, UUID chatId, UUID messageId, String text)
            throws Exception {
        return mockMvc.perform(authed(patch(
                        "/api/v1/chats/{chatId}/messages/{messageId}", chatId, messageId),
                        session)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("text", text))))
                .andReturn();
    }

    private JsonNode dlpEvents(SessionResponse session, UUID workspaceId) throws Exception {
        MvcResult result = mockMvc.perform(authed(
                        get("/api/v1/workspaces/{id}/dlp/events", workspaceId), session))
                .andExpect(status().isOk())
                .andReturn();
        return json(result);
    }

    private JsonNode item(JsonNode page, UUID messageId) {
        for (JsonNode item : page.get("items")) {
            if (messageId.toString().equals(item.get("id").asText())) {
                return item;
            }
        }
        throw new AssertionError("message not found: " + messageId);
    }

    private void assertDlpBlocked(MvcResult result, String surface) throws Exception {
        assertThat(result.getResponse().getStatus())
                .as(result.getResponse().getContentAsString()).isEqualTo(422);
        JsonNode body = json(result);
        assertThat(body.get("code").asText()).isEqualTo("DLP_BLOCKED");
        assertThat(body.get("details").get("surface").asText()).isEqualTo(surface);
    }

    private long uploadCount(UUID chatId) {
        Long count = migrator().queryForObject(
                "SELECT count(*) FROM file.uploads WHERE chat_id = ?", Long.class, chatId);
        return count == null ? 0 : count;
    }

    private UUID attachmentMessageId(UUID attachmentId) {
        return migrator().queryForObject(
                "SELECT message_id FROM file.attachments WHERE id = ?", UUID.class,
                attachmentId);
    }

    private long dlpEventCount(UUID workspaceId) {
        Long count = migrator().queryForObject(
                "SELECT count(*) FROM workspace.dlp_events WHERE workspace_id = ?",
                Long.class, workspaceId);
        return count == null ? 0 : count;
    }

    private String dlpEventRows(UUID workspaceId) {
        String rows = migrator().queryForObject("""
                SELECT coalesce(string_agg(row_to_json(e)::text, ' '), '')
                  FROM workspace.dlp_events e WHERE e.workspace_id = ?
                """, String.class, workspaceId);
        return rows == null ? "" : rows;
    }

    private long pluginCount(String table, UUID chatId) {
        Long count = migrator().queryForObject(
                "SELECT count(*) FROM " + table + " WHERE chat_id = ?", Long.class, chatId);
        return count == null ? 0 : count;
    }

    private static byte[] bytes(String value) {
        return value.getBytes(StandardCharsets.UTF_8);
    }
}
