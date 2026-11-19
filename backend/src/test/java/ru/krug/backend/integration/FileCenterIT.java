package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

import ru.krug.backend.file.application.model.FilePageCursor;
import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.support.FileUploadTestSupport;
import ru.krug.backend.support.OpenApiContract;

/**
 * #73 file-center functional coverage: workspace/chat membership, E2EE exclusion, deleted
 * and unbound attachments, filters/search, stable keyset pagination and the quota summary.
 */
@ActiveProfiles("test")
class FileCenterIT extends FileUploadTestSupport {

    private static final OpenApiContract CONTRACT = OpenApiContract.load();

    @Test
    void listsBoundFilesWithProvenanceAndQuota() throws Exception {
        SessionResponse session = devSession();
        UUID workspaceId = session.workspace().id();
        UUID chatId = session.chat().id();
        byte[] report = randomBytes(1000);
        byte[] photo = randomBytes(2000);
        UUID reportId = upload(session, chatId, "report.pdf", report, "application/pdf");
        UUID photoId = upload(session, chatId, "photo.png", photo, "image/png");
        UUID messageId = sendFiles(session, chatId, List.of(reportId, photoId));

        JsonNode page = filesOk(session, "workspace_id", workspaceId.toString());
        CONTRACT.assertValid("FilePage", page);
        assertThat(page.get("items")).hasSize(2);
        assertThat(page.at("/page/has_more").asBoolean()).isFalse();
        assertThat(page.at("/page/next_cursor").isNull()).isTrue();

        JsonNode item = item(page, "report.pdf");
        CONTRACT.assertValid("FileItem", item);
        assertThat(item.get("chat_id").asText()).isEqualTo(chatId.toString());
        assertThat(item.get("chat_name").asText()).isEqualTo(session.chat().name());
        assertThat(item.get("message_id").asText()).isEqualTo(messageId.toString());
        assertThat(item.get("scan_status").asText()).isEqualTo("CLEAN");
        assertThat(item.get("mime_type").asText()).isEqualTo("application/pdf");
        assertThat(item.get("size_bytes").asLong()).isEqualTo(report.length);
        assertThat(item.get("created_at").asText()).isNotBlank();
        assertThat(item.get("media").isNull()).isTrue();

        // Metadata only: no object key, content hash, bytes or presigned URL.
        assertThat(item.has("object_key")).isFalse();
        assertThat(item.has("sha256")).isFalse();
        assertThat(item.has("url")).isFalse();
        assertThat(item.has("content")).isFalse();
        assertThat(page.toString()).doesNotContain(reportId + "/download");

        JsonNode quota = page.get("quota");
        assertThat(quota).isNotNull();
        assertThat(quota.get("used_bytes").asLong()).isEqualTo(report.length + photo.length);
        assertThat(quota.get("reserved_bytes").asLong()).isZero();
        assertThat(quota.get("storage_bytes").asLong()).isEqualTo(1L << 40);
        assertThat(quota.get("percent").asInt()).isZero();
    }

    @Test
    void filtersByKindMimeExtensionLiteralSearchAndScanStatus() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();
        UUID report = upload(session, chatId, "Quarterly Report.PDF", randomBytes(300),
                "application/pdf");
        UUID photo = upload(session, chatId, "Photo.PNG", randomBytes(400), "image/png");
        UUID song = upload(session, chatId, "song.mp3", randomBytes(500), "audio/mpeg");
        sendFiles(session, chatId, List.of(report, photo, song));

        assertThat(filenames(filesOk(session, "kind", "IMAGE"))).containsExactly("Photo.PNG");
        assertThat(filenames(filesOk(session, "kind", "file")))
                .containsExactly("Quarterly Report.PDF");
        assertThat(filesOk(session, "kind", "VIDEO").get("items").size()).isZero();
        assertThat(filenames(filesOk(session, "mime", "Application/PDF")))
                .containsExactly("Quarterly Report.PDF");
        assertThat(filenames(filesOk(session, "extension", ".PDF")))
                .containsExactly("Quarterly Report.PDF");
        assertThat(filenames(filesOk(session, "query", "report")))
                .containsExactly("Quarterly Report.PDF");
        assertThat(filenames(filesOk(session, "query", "%"))).isEmpty();
        assertThat(filenames(filesOk(session, "query", "image/png")))
                .containsExactly("Photo.PNG");
        assertThat(filesOk(session, "scan_status", "CLEAN").get("items")).hasSize(3);
        assertThat(filesOk(session, "scan_status", "INFECTED").get("items").size()).isZero();

        assertBadRequest(files(session, "kind", "ARCHIVE"), "kind");
        assertBadRequest(files(session, "scan_status", "MAYBE"), "scan_status");
        assertBadRequest(files(session, "mime", "not a mime"), "mime");
        assertBadRequest(files(session, "extension", "p df"), "extension");
        assertBadRequest(files(session, "query", "x".repeat(201)), "query");
        assertBadRequest(files(session, "limit", "0"), "limit");
        assertBadRequest(files(session, "limit", "101"), "limit");
        assertBadRequest(files(session, "cursor", "not-a-cursor"), "cursor");
    }

    @Test
    void filtersByChatAndHidesForeignOrRemovedChats() throws Exception {
        SessionResponse session = devSession();
        UUID workspaceId = session.workspace().id();
        UUID directChatId = session.chat().id();
        UUID groupChatId = createGroupChat(session, workspaceId, "Files Group");
        UUID directFile = upload(session, directChatId, "direct.txt", randomBytes(100),
                "text/plain");
        UUID groupFile = upload(session, groupChatId, "group.txt", randomBytes(200),
                "text/plain");
        sendFiles(session, directChatId, List.of(directFile));
        sendFiles(session, groupChatId, List.of(groupFile));

        JsonNode groupPage = filesOk(session, "chat_id", groupChatId.toString());
        assertThat(groupPage.get("items")).hasSize(1);
        assertThat(groupPage.get("items").get(0).get("chat_name").asText())
                .isEqualTo("Files Group");
        assertThat(groupPage.get("items").get(0).get("chat_id").asText())
                .isEqualTo(groupChatId.toString());

        JsonNode directPage = filesOk(session, "chat_id", directChatId.toString());
        assertThat(filenames(directPage)).containsExactly("direct.txt");
        assertThat(directPage.get("items").get(0).get("chat_name").asText())
                .isEqualTo(session.chat().name());

        SessionResponse outsider = devSession();
        MvcResult foreignWorkspace = files(session, "workspace_id",
                outsider.workspace().id().toString());
        assertThat(foreignWorkspace.getResponse().getStatus()).isEqualTo(403);
        CONTRACT.assertValid("Error", json(foreignWorkspace));
        assertThat(json(foreignWorkspace).get("code").asText()).isEqualTo("FORBIDDEN");

        MvcResult foreignChat = files(session, "chat_id", outsider.chat().id().toString());
        assertThat(foreignChat.getResponse().getStatus()).isEqualTo(404);
        assertThat(json(foreignChat).get("code").asText()).isEqualTo("NOT_FOUND");

        MvcResult foreignChatInOwnWorkspace = files(session, "workspace_id",
                workspaceId.toString(), "chat_id", outsider.chat().id().toString());
        assertThat(foreignChatInOwnWorkspace.getResponse().getStatus()).isEqualTo(404);

        // Create then leave a chat: its files must disappear and the chat filter must 404.
        UUID leftChatId = createGroupChat(session, workspaceId, "Left Chat");
        UUID leftFile = upload(session, leftChatId, "left.txt", randomBytes(50), "text/plain");
        sendFiles(session, leftChatId, List.of(leftFile));
        migrator().update("""
                UPDATE chat.chat_members SET status = 'REMOVED'
                 WHERE chat_id = ? AND user_id = ?
                """, leftChatId, session.user().id());
        assertThat(filenames(filesOk(session, "workspace_id", workspaceId.toString())))
                .doesNotContain("left.txt");
        assertThat(files(session, "chat_id", leftChatId.toString()).getResponse().getStatus())
                .isEqualTo(404);
    }

    @Test
    void paginatesStablyThroughAllFiles() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();
        List<UUID> attachmentIds = new ArrayList<>();
        for (int i = 0; i < 5; i++) {
            attachmentIds.add(upload(session, chatId, "page-" + i + ".txt",
                    randomBytes(100 + i), "text/plain"));
        }
        sendFiles(session, chatId, attachmentIds);

        JsonNode all = filesOk(session, "limit", "100");
        assertThat(all.get("items")).hasSize(5);
        List<String> expectedOrder = ids(all);
        assertThat(all.at("/page/has_more").asBoolean()).isFalse();

        List<String> paged = new ArrayList<>();
        String cursor = null;
        int pages = 0;
        boolean hasMore = true;
        while (hasMore) {
            MvcResult result = cursor == null
                    ? files(session, "limit", "2")
                    : files(session, "limit", "2", "cursor", cursor);
            assertThat(result.getResponse().getStatus())
                    .as(result.getResponse().getContentAsString()).isEqualTo(200);
            JsonNode page = json(result);
            page.get("items").forEach(item -> paged.add(item.get("id").asText()));
            hasMore = page.at("/page/has_more").asBoolean();
            cursor = page.at("/page/next_cursor").isNull() ? null
                    : page.at("/page/next_cursor").asText();
            pages++;
            assertThat(pages).isLessThanOrEqualTo(4);
        }
        assertThat(pages).isEqualTo(3);
        assertThat(paged).containsExactlyElementsOf(expectedOrder);
        assertThat(new HashSet<>(paged)).hasSize(5);

        // A cursor is bound to its workspace: a valid cursor from another workspace is 400.
        SessionResponse outsider = devSession();
        String foreignCursor = new FilePageCursor(outsider.workspace().id(), Instant.now(),
                UUID.randomUUID()).encode();
        assertBadRequest(files(session, "cursor", foreignCursor), "cursor");
    }

    @Test
    void neverReturnsE2eeChatOrE2eeMessageAttachments() throws Exception {
        SessionResponse session = devSession();
        UUID workspaceId = session.workspace().id();
        UUID e2eeChatId = UUID.randomUUID();
        migrator().update("""
                INSERT INTO chat.chats (id, workspace_id, type, security_mode, name, created_by)
                VALUES (?, ?, 'GROUP', 'E2EE', 'e2ee-files', ?)
                """, e2eeChatId, workspaceId, session.user().id());
        migrator().update("""
                INSERT INTO chat.chat_members (chat_id, workspace_id, user_id, role, status)
                VALUES (?, ?, ?, 'OWNER', 'ACTIVE')
                """, e2eeChatId, workspaceId, session.user().id());
        migrator().update("""
                INSERT INTO chat.chat_counters (chat_id, workspace_id) VALUES (?, ?)
                """, e2eeChatId, workspaceId);

        UUID attachmentId = upload(session, e2eeChatId, "e2ee-secret.bin",
                randomBytes(128), "application/octet-stream");
        migrator().execute("SELECT message.ensure_partition(date_trunc('month', now())::date)");
        UUID messageId = UUID.randomUUID();
        migrator().update("""
                INSERT INTO message.messages
                       (id, workspace_id, chat_id, seq, sender_id, sender_device_id,
                        sender_display_name, type, crypto_scheme, content_meta, created_at,
                        version)
                VALUES (?, ?, ?, 1, ?, ?, 'tester', 'TEXT', 'E2EE_PAIRWISE', '{}'::jsonb,
                        now(), 1)
                """, messageId, workspaceId, e2eeChatId, session.user().id(),
                session.device().id());
        migrator().update("""
                UPDATE file.attachments SET message_id = ?, status = 'BOUND' WHERE id = ?
                """, messageId, attachmentId);

        assertThat(filenames(filesOk(session, "workspace_id", workspaceId.toString())))
                .doesNotContain("e2ee-secret.bin");
        assertThat(filesOk(session, "chat_id", e2eeChatId.toString()).get("items").size()).isZero();

        // The same file in a MANAGED chat is visible, proving exclusion is mode-based.
        UUID managedChatId = session.chat().id();
        UUID managedAttachment = upload(session, managedChatId, "managed.txt",
                randomBytes(64), "text/plain");
        sendFiles(session, managedChatId, List.of(managedAttachment));
        assertThat(filenames(filesOk(session, "workspace_id", workspaceId.toString())))
                .containsExactly("managed.txt");
    }

    @Test
    void excludesDeletedForAllAndDeletedForMeMessages() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();
        UUID forMe = upload(session, chatId, "for-me.txt", randomBytes(100), "text/plain");
        UUID forAll = upload(session, chatId, "for-all.txt", randomBytes(100), "text/plain");
        UUID forMeMessage = sendFiles(session, chatId, List.of(forMe));
        UUID forAllMessage = sendFiles(session, chatId, List.of(forAll));
        assertThat(filenames(filesOk(session, "chat_id", chatId.toString())))
                .containsExactlyInAnyOrder("for-me.txt", "for-all.txt");

        MvcResult hidden = mockMvc.perform(authed(delete(
                "/api/v1/chats/{chatId}/messages/{messageId}", chatId, forMeMessage), session)
                .param("scope", "me")).andReturn();
        assertThat(hidden.getResponse().getStatus()).isEqualTo(204);
        assertThat(filenames(filesOk(session, "chat_id", chatId.toString())))
                .containsExactly("for-all.txt");

        MvcResult deleted = mockMvc.perform(authed(delete(
                "/api/v1/chats/{chatId}/messages/{messageId}", chatId, forAllMessage), session)
                .param("scope", "all")).andReturn();
        assertThat(deleted.getResponse().getStatus()).isEqualTo(204);
        assertThat(filesOk(session, "chat_id", chatId.toString()).get("items").size()).isZero();
        assertThat(migrator().queryForObject("""
                SELECT status FROM file.attachments WHERE id = ?
                """, String.class, forAll)).isEqualTo("DELETED");
    }

    @Test
    void excludesUploadsThatWereNeverBoundToAMessage() throws Exception {
        SessionResponse session = devSession();
        UUID workspaceId = session.workspace().id();
        UUID chatId = session.chat().id();
        byte[] data = randomBytes(256);
        upload(session, chatId, "not-sent.txt", data, "text/plain");

        JsonNode page = filesOk(session, "workspace_id", workspaceId.toString());
        assertThat(page.get("items").size()).isZero();
        // Quota was committed at complete even though the file is not listed yet.
        assertThat(page.at("/quota/used_bytes").asLong()).isEqualTo(data.length);
    }

    @Test
    void workspaceIdIsOptionalWithADevClaimOrAChatId() throws Exception {
        SessionResponse session = devSession();
        UUID workspaceId = session.workspace().id();
        UUID chatId = session.chat().id();
        UUID attachmentId = upload(session, chatId, "claim.txt", randomBytes(80), "text/plain");
        sendFiles(session, chatId, List.of(attachmentId));

        JsonNode withWorkspace = filesOk(session, "workspace_id", workspaceId.toString());
        JsonNode withoutWorkspace = filesOk(session);
        JsonNode byChatOnly = filesOk(session, "chat_id", chatId.toString());
        assertThat(ids(withoutWorkspace)).containsExactlyElementsOf(ids(withWorkspace));
        assertThat(ids(byChatOnly)).containsExactlyElementsOf(ids(withWorkspace));
    }

    @Test
    void emptyWorkspaceHasZeroQuotaAndNoItems() throws Exception {
        SessionResponse session = devSession();
        JsonNode page = filesOk(session, "workspace_id", session.workspace().id().toString());
        assertThat(page.get("items").size()).isZero();
        assertThat(page.at("/quota/used_bytes").asLong()).isZero();
        assertThat(page.at("/quota/reserved_bytes").asLong()).isZero();
        assertThat(page.at("/quota/percent").asInt()).isZero();
    }

    // ------------------------------------------------------------------

    private UUID upload(SessionResponse session, UUID chatId, String filename, byte[] data,
                        String mime) throws Exception {
        JsonNode upload = uploadFile(session, chatId, filename, data, mime);
        return UUID.fromString(upload.get("attachment_id").asText());
    }

    private UUID sendFiles(SessionResponse session, UUID chatId, List<UUID> attachmentIds)
            throws Exception {
        MvcResult send = sendWithAttachments(session, chatId, null, attachmentIds);
        assertThat(send.getResponse().getStatus())
                .as(send.getResponse().getContentAsString()).isEqualTo(201);
        return UUID.fromString(json(send).get("id").asText());
    }

    private UUID createGroupChat(SessionResponse session, UUID workspaceId, String name)
            throws Exception {
        MvcResult result = mockMvc.perform(authed(
                        post("/api/v1/workspaces/{workspaceId}/chats", workspaceId), session)
                .header("Idempotency-Key", UUID.randomUUID().toString())
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(Map.of(
                        "type", "GROUP", "name", name))))
                .andReturn();
        assertThat(result.getResponse().getStatus())
                .as(result.getResponse().getContentAsString()).isEqualTo(201);
        return UUID.fromString(json(result).get("id").asText());
    }

    private MvcResult files(SessionResponse session, String... params) throws Exception {
        MockHttpServletRequestBuilder builder = get("/api/v1/files");
        for (int i = 0; i + 1 < params.length; i += 2) {
            builder.param(params[i], params[i + 1]);
        }
        return mockMvc.perform(authed(builder, session)).andReturn();
    }

    private JsonNode filesOk(SessionResponse session, String... params) throws Exception {
        MvcResult result = files(session, params);
        assertThat(result.getResponse().getStatus())
                .as(result.getResponse().getContentAsString()).isEqualTo(200);
        return json(result);
    }

    private void assertBadRequest(MvcResult result, String field) throws Exception {
        assertThat(result.getResponse().getStatus())
                .as(result.getResponse().getContentAsString()).isEqualTo(400);
        JsonNode error = json(result);
        CONTRACT.assertValid("Error", error);
        assertThat(error.get("code").asText()).isEqualTo("VALIDATION_FAILED");
        assertThat(error.at("/details/field").asText()).isEqualTo(field);
    }

    private static JsonNode item(JsonNode page, String filename) {
        for (JsonNode item : page.get("items")) {
            if (filename.equals(item.get("filename").asText())) {
                return item;
            }
        }
        throw new AssertionError("file not found in page: " + filename);
    }

    private static Set<String> filenames(JsonNode page) {
        Set<String> names = new HashSet<>();
        page.get("items").forEach(item -> names.add(item.get("filename").asText()));
        return names;
    }

    private static List<String> ids(JsonNode page) {
        List<String> ids = new ArrayList<>();
        page.get("items").forEach(item -> ids.add(item.get("id").asText()));
        return ids;
    }
}
