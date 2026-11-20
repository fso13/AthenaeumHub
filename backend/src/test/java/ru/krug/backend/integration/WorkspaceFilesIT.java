package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MvcResult;

import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.shared.application.model.IssuedToken;
import ru.krug.backend.shared.application.port.TokenIssuer;
import ru.krug.backend.support.FileUploadTestSupport;
import ru.krug.backend.support.OpenApiContract;

/**
 * #83 global workspace files: multipart upload through the managed FileTypePolicy/AV
 * pipeline, owner-only visibility before binding, rename/delete authorization and the
 * workspace-file -> message binding.
 */
@ActiveProfiles("test")
class WorkspaceFilesIT extends FileUploadTestSupport {

    private static final OpenApiContract CONTRACT = OpenApiContract.load();

    @Autowired
    private TokenIssuer tokenIssuer;

    @Test
    void uploadsAnAllowedTypeScansItAndListsItForTheOwner() throws Exception {
        SessionResponse session = devSession();
        UUID workspaceId = session.workspace().id();
        byte[] data = randomBytes(1024);

        MvcResult result = upload(session, workspaceId, "report.pdf", data, "application/pdf");
        assertThat(result.getResponse().getStatus())
                .as(result.getResponse().getContentAsString()).isEqualTo(201);
        JsonNode item = json(result);
        CONTRACT.assertValid("FileItem", item);
        UUID fileId = UUID.fromString(item.get("id").asText());
        assertThat(item.get("filename").asText()).isEqualTo("report.pdf");
        assertThat(item.get("size_bytes").asLong()).isEqualTo(data.length);
        assertThat(item.get("scan_status").asText()).isEqualTo("PENDING");
        assertThat(item.get("chat_id").isNull()).isTrue();
        assertThat(item.get("chat_name").isNull()).isTrue();
        assertThat(item.get("message_id").isNull()).isTrue();
        assertThat(item.has("object_key")).isFalse();
        assertThat(item.has("sha256")).isFalse();
        assertThat(item.has("url")).isFalse();

        // The existing scan worker promotes PENDING -> CLEAN; only then is download allowed.
        assertThat(awaitScan(session, fileId, 200)).isEqualTo(200);

        JsonNode page = files(session, workspaceId);
        assertThat(page.get("items")).hasSize(1);
        JsonNode listed = page.get("items").get(0);
        CONTRACT.assertValid("FileItem", listed);
        assertThat(listed.get("id").asText()).isEqualTo(fileId.toString());
        assertThat(listed.get("scan_status").asText()).isEqualTo("CLEAN");
        assertThat(page.get("quota").get("used_bytes").asLong()).isEqualTo(data.length);
        assertThat(page.get("quota").get("reserved_bytes").asLong()).isZero();
    }

    @Test
    void enforcesMembershipPolicyAndSizeWithoutBypassingTheScanPipeline() throws Exception {
        SessionResponse session = devSession();
        UUID workspaceId = session.workspace().id();

        MvcResult dangerous = upload(session, workspaceId, "evil.exe", randomBytes(10),
                "application/octet-stream");
        assertThat(dangerous.getResponse().getStatus())
                .as(dangerous.getResponse().getContentAsString()).isEqualTo(422);
        CONTRACT.assertValid("Error", json(dangerous));
        assertThat(json(dangerous).get("code").asText()).isEqualTo("DANGEROUS_TYPE_BLOCKED");

        MvcResult unsupported = upload(session, workspaceId, "notes.xyz", randomBytes(10),
                "text/plain");
        assertThat(unsupported.getResponse().getStatus()).isEqualTo(415);
        CONTRACT.assertValid("Error", json(unsupported));
        assertThat(json(unsupported).get("code").asText()).isEqualTo("UNSUPPORTED_TYPE");

        MvcResult traversal = upload(session, workspaceId, "../escape.txt", randomBytes(10),
                "text/plain");
        assertThat(traversal.getResponse().getStatus()).isEqualTo(400);
        assertThat(json(traversal).get("code").asText()).isEqualTo("VALIDATION_FAILED");

        setLimits(workspaceId, 64, 1L << 40, 10);
        MvcResult tooLarge = upload(session, workspaceId, "big.txt", randomBytes(100),
                "text/plain");
        assertThat(tooLarge.getResponse().getStatus()).isEqualTo(413);
        CONTRACT.assertValid("Error", json(tooLarge));
        assertThat(json(tooLarge).get("code").asText()).isEqualTo("FILE_TOO_LARGE");
        assertThat(usedBytes(workspaceId)).isZero();

        SessionResponse outsider = devSession();
        MvcResult foreign = upload(outsider, workspaceId, "foreign.txt", randomBytes(10),
                "text/plain");
        assertThat(foreign.getResponse().getStatus()).isEqualTo(403);
        assertThat(json(foreign).get("code").asText()).isEqualTo("FORBIDDEN");
    }

    @Test
    void renameIsOwnerOnlyAndDeleteIsOwnerOrWorkspaceAdmin() throws Exception {
        SessionResponse owner = devSession();
        SessionResponse member = devSession();
        SessionResponse admin = devSession();
        UUID workspaceId = owner.workspace().id();
        joinWorkspace(owner, workspaceId, member);
        joinWorkspace(owner, workspaceId, admin);
        changeWorkspaceRole(owner, workspaceId, admin.user().id(), "ADMIN");
        SessionResponse memberScoped = scoped(member, workspaceId);
        SessionResponse adminScoped = scoped(admin, workspaceId);

        MvcResult uploaded = upload(owner, workspaceId, "draft.pdf", randomBytes(300),
                "application/pdf");
        assertThat(uploaded.getResponse().getStatus()).isEqualTo(201);
        UUID fileId = UUID.fromString(json(uploaded).get("id").asText());

        // Another workspace member cannot see an unbound global file, so rename is hidden.
        assertThat(files(memberScoped, workspaceId).get("items")).isEmpty();
        MvcResult foreignRename = rename(memberScoped, fileId, "hijack.pdf");
        assertThat(foreignRename.getResponse().getStatus()).isEqualTo(404);

        MvcResult renamed = rename(owner, fileId, "final name.pdf");
        assertThat(renamed.getResponse().getStatus())
                .as(renamed.getResponse().getContentAsString()).isEqualTo(200);
        CONTRACT.assertValid("FileItem", json(renamed));
        assertThat(json(renamed).get("filename").asText()).isEqualTo("final name.pdf");
        assertThat(files(owner, workspaceId).get("items").get(0).get("filename").asText())
                .isEqualTo("final name.pdf");

        MvcResult memberDelete = deleteFile(memberScoped, fileId);
        assertThat(memberDelete.getResponse().getStatus()).isEqualTo(403);
        assertThat(json(memberDelete).get("code").asText()).isEqualTo("FORBIDDEN");

        // A workspace ADMIN may delete another member's unbound global file.
        MvcResult adminDelete = deleteFile(adminScoped, fileId);
        assertThat(adminDelete.getResponse().getStatus()).isEqualTo(204);
        assertThat(usedBytes(workspaceId)).isZero();
        assertThat(files(owner, workspaceId).get("items")).isEmpty();
        assertThat(migrator().queryForObject("""
                SELECT status FROM file.attachments WHERE id = ?
                """, String.class, fileId)).isEqualTo("DELETED");

        // Idempotent repeat.
        assertThat(deleteFile(adminScoped, fileId).getResponse().getStatus()).isEqualTo(204);
    }

    @Test
    void aRenameCommittedDuringTheScanIsNotOverwrittenByTheVerdict() throws Exception {
        SessionResponse session = devSession();
        UUID workspaceId = session.workspace().id();
        MvcResult uploaded = upload(session, workspaceId, "scan-race.pdf", randomBytes(400),
                "application/pdf");
        assertThat(uploaded.getResponse().getStatus()).isEqualTo(201);
        UUID fileId = UUID.fromString(json(uploaded).get("id").asText());

        // Rename immediately: the AV worker may already hold the pre-rename snapshot.
        MvcResult renamed = rename(session, fileId, "kept-name.pdf");
        assertThat(renamed.getResponse().getStatus()).isEqualTo(200);
        assertThat(awaitScan(session, fileId, 200)).isEqualTo(200);

        JsonNode listed = files(session, workspaceId).get("items").get(0);
        assertThat(listed.get("filename").asText()).isEqualTo("kept-name.pdf");
        assertThat(listed.get("scan_status").asText()).isEqualTo("CLEAN");
    }

    @Test
    void aGlobalFileCanBeAttachedToAMessageAndThenFollowsChatVisibility() throws Exception {
        SessionResponse owner = devSession();
        SessionResponse member = devSession();
        UUID workspaceId = owner.workspace().id();
        UUID chatId = createGroupChat(owner, workspaceId, "Shared files");
        joinWorkspace(owner, workspaceId, member);
        addChatMember(owner, chatId, member.user().id(), "MEMBER");
        SessionResponse memberScoped = scoped(member, workspaceId);

        MvcResult uploaded = upload(owner, workspaceId, "shared.pdf", randomBytes(200),
                "application/pdf");
        UUID fileId = UUID.fromString(json(uploaded).get("id").asText());
        assertThat(files(memberScoped, workspaceId).get("items")).isEmpty();
        // A message may not reference an unscanned object: the AV gate is fail-closed, so
        // binding waits for the CLEAN verdict exactly like a regular chat upload.
        assertThat(awaitScan(owner, fileId, 200)).isEqualTo(200);

        MvcResult sent = sendWithAttachments(owner, chatId, "see attached", List.of(fileId));
        assertThat(sent.getResponse().getStatus())
                .as(sent.getResponse().getContentAsString()).isEqualTo(201);
        JsonNode message = json(sent);
        assertThat(message.get("attachments")).hasSize(1);
        assertThat(message.at("/attachments/0/id").asText()).isEqualTo(fileId.toString());

        JsonNode ownerPage = files(owner, workspaceId);
        JsonNode item = ownerPage.get("items").get(0);
        assertThat(item.get("chat_id").asText()).isEqualTo(chatId.toString());
        assertThat(item.get("message_id").asText())
                .isEqualTo(message.get("id").asText());

        // Once bound, the file follows the regular chat-membership visibility.
        JsonNode memberPage = files(memberScoped, workspaceId);
        assertThat(memberPage.get("items")).hasSize(1);
        assertThat(memberPage.get("items").get(0).get("filename").asText())
                .isEqualTo("shared.pdf");

        MvcResult deleteBound = deleteFile(owner, fileId);
        assertThat(deleteBound.getResponse().getStatus()).isEqualTo(409);
        assertThat(json(deleteBound).get("code").asText()).isEqualTo("CONFLICT");
    }

    // ------------------------------------------------------------------

    private long usedBytes(UUID workspaceId) {
        Long used = migrator().queryForObject("""
                SELECT COALESCE((SELECT used_bytes FROM file.workspace_usage
                                  WHERE workspace_id = ?), 0)
                """, Long.class, workspaceId);
        return used == null ? 0 : used;
    }

    private MvcResult upload(SessionResponse session, UUID workspaceId, String filename,
                             byte[] data, String mime) throws Exception {
        MockMultipartFile file = new MockMultipartFile("file", filename, mime, data);
        return mockMvc.perform(authed(multipart("/api/v1/workspaces/{workspaceId}/files",
                workspaceId).file(file), session)).andReturn();
    }

    private MvcResult rename(SessionResponse session, UUID fileId, String name) throws Exception {
        return mockMvc.perform(authed(patch("/api/v1/files/{fileId}", fileId), session)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(Map.of("name", name)))).andReturn();
    }

    private MvcResult deleteFile(SessionResponse session, UUID fileId) throws Exception {
        return mockMvc.perform(authed(delete("/api/v1/files/{fileId}", fileId), session))
                .andReturn();
    }

    private JsonNode files(SessionResponse session, UUID workspaceId) throws Exception {
        MvcResult result = mockMvc.perform(authed(get("/api/v1/files"), session)
                .param("workspace_id", workspaceId.toString())).andReturn();
        assertThat(result.getResponse().getStatus())
                .as(result.getResponse().getContentAsString()).isEqualTo(200);
        return json(result);
    }

    private UUID createGroupChat(SessionResponse session, UUID workspaceId, String name)
            throws Exception {
        MvcResult result = mockMvc.perform(authed(
                        post("/api/v1/workspaces/{workspaceId}/chats", workspaceId), session)
                .header("Idempotency-Key", UUID.randomUUID().toString())
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(Map.of("type", "GROUP", "name", name))))
                .andReturn();
        assertThat(result.getResponse().getStatus())
                .as(result.getResponse().getContentAsString()).isEqualTo(201);
        return UUID.fromString(json(result).get("id").asText());
    }

    private void joinWorkspace(SessionResponse owner, UUID workspaceId, SessionResponse user)
            throws Exception {
        String email = migrator().queryForObject("SELECT email FROM auth.users WHERE id = ?",
                String.class, user.user().id());
        MvcResult result = mockMvc.perform(authed(post(
                "/api/v1/workspaces/{workspaceId}/members", workspaceId), owner)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(Map.of("email", email,
                        "role", "MEMBER")))).andReturn();
        assertThat(result.getResponse().getStatus())
                .as(result.getResponse().getContentAsString()).isEqualTo(201);
    }

    private void changeWorkspaceRole(SessionResponse owner, UUID workspaceId, UUID userId,
                                     String role) throws Exception {
        MvcResult result = mockMvc.perform(authed(patch(
                        "/api/v1/workspaces/{workspaceId}/members/{userId}", workspaceId, userId),
                        owner)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(Map.of("role", role)))).andReturn();
        assertThat(result.getResponse().getStatus())
                .as(result.getResponse().getContentAsString()).isEqualTo(200);
    }

    private void addChatMember(SessionResponse owner, UUID chatId, UUID userId, String role)
            throws Exception {
        MvcResult result = mockMvc.perform(authed(post("/api/v1/chats/{chatId}/members", chatId),
                        owner)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(Map.of("user_id", userId.toString(),
                        "role", role)))).andReturn();
        assertThat(result.getResponse().getStatus())
                .as(result.getResponse().getContentAsString()).isIn(200, 201);
    }

    private SessionResponse scoped(SessionResponse user, UUID workspaceId) {
        IssuedToken token = tokenIssuer.issue(user.user().id(), user.device().id(), workspaceId);
        return new SessionResponse(token.accessToken(), token.expiresAt(), user.user(),
                user.device(), user.workspace(), user.chat());
    }
}
