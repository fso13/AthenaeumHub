package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockMultipartHttpServletRequestBuilder;

import ru.krug.backend.file.application.port.ObjectStoragePort;
import ru.krug.backend.file.application.usecase.DirectImageUploadHandler;
import ru.krug.backend.file.application.usecase.UploadGcHandler;
import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.support.IntegrationTestBase;
import ru.krug.backend.support.OpenApiContract;
import ru.krug.backend.support.TestImages;

/**
 * #92: direct device image upload and its use as avatar/cover/logo. Runs the real
 * REST/DB/storage/audit stack; the in-memory storage adapter mirrors the S3 contract.
 */
@ActiveProfiles("test")
class DirectImageUploadIT extends IntegrationTestBase {

    private static final OpenApiContract CONTRACT = OpenApiContract.load();

    @Autowired
    private ObjectStoragePort objectStorage;

    @Autowired
    private UploadGcHandler uploadGcHandler;

    @Test
    void pngUploadCreatesReadySkippedDirectImageAndAuditsMetadataOnly() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("img-png"));
        MvcResult result = upload(owner, "avatar.png", "image/png",
                TestImages.png(24, 16), null)
                .andExpect(status().isCreated()).andReturn();
        JsonNode body = json(result);
        CONTRACT.assertValid("UploadedImage", body);
        assertThat(body.get("width").asInt()).isEqualTo(24);
        assertThat(body.get("height").asInt()).isEqualTo(16);
        assertThat(body.get("mime").asText()).isEqualTo("image/png");
        assertThat(body.get("size").asLong()).isEqualTo(TestImages.png(24, 16).length);
        UUID fileId = UUID.fromString(body.get("file_id").asText());

        Map<String, Object> row = migrator().queryForMap("""
                SELECT workspace_id, chat_id, upload_id, user_id, mime_type, size_bytes, status,
                       scan_status, source, media->>'kind' AS kind,
                       media->>'width' AS width, media->>'height' AS height,
                       media->>'metadata_source' AS metadata_source, object_key
                  FROM file.attachments WHERE id = ?
                """, fileId);
        assertThat(row.get("workspace_id")).isEqualTo(owner.workspace().id());
        assertThat(row.get("chat_id")).isNull();
        assertThat(row.get("upload_id")).isNull();
        assertThat(row.get("user_id")).isEqualTo(owner.user().id());
        assertThat(row.get("status")).isEqualTo("READY");
        assertThat(row.get("scan_status")).isEqualTo("SKIPPED");
        assertThat(row.get("source")).isEqualTo("DIRECT_IMAGE");
        assertThat(row.get("kind")).isEqualTo("IMAGE");
        assertThat(row.get("width")).isEqualTo("24");
        assertThat(row.get("height")).isEqualTo("16");
        assertThat(row.get("metadata_source")).isEqualTo("SERVER");

        String objectKey = (String) row.get("object_key");
        assertThat(objectKey).startsWith("workspaces/" + owner.workspace().id() + "/images/");
        assertThat(objectKey).doesNotContain("avatar.png").doesNotContain("..");
        assertThat(objectStorage.exists(objectKey)).isTrue();
        assertThat(result.getResponse().getContentAsString()).doesNotContain(objectKey);
        mockMvc.perform(authed(get("/api/v1/attachments/{attachmentId}/download-url", fileId),
                        owner))
                .andExpect(status().isOk());

        String metadata = migrator().queryForObject("""
                SELECT metadata::text FROM audit.audit_events
                 WHERE action = 'file.image.uploaded' AND actor_id = ?
                 ORDER BY created_at DESC LIMIT 1
                """, String.class, owner.user().id());
        assertThat(metadata).contains("\"mime\"", "\"size_bytes\"", "\"width\"", "\"height\"",
                "\"chat_bound\"").doesNotContain("avatar.png", objectKey, "object_key");
    }

    @Test
    void jpegAndWebpAreAcceptedAndExifNeverLeaks() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("img-formats"));
        byte[] jpeg = TestImages.jpegWithExif(12, 10, "SECRET-EXIF-VALUE");
        MvcResult jpegResult = upload(owner, "photo.jpg", "image/jpeg", jpeg, null)
                .andExpect(status().isCreated()).andReturn();
        assertThat(json(jpegResult).get("mime").asText()).isEqualTo("image/jpeg");
        assertThat(json(jpegResult).get("width").asInt()).isEqualTo(12);
        assertThat(jpegResult.getResponse().getContentAsString())
                .doesNotContain("SECRET-EXIF-VALUE");
        UUID jpegId = UUID.fromString(json(jpegResult).get("file_id").asText());
        assertThat(migrator().queryForObject(
                "SELECT media::text FROM file.attachments WHERE id = ?", String.class, jpegId))
                .doesNotContain("SECRET-EXIF-VALUE");

        MvcResult webpResult = upload(owner, "cover.webp", "image/webp",
                TestImages.webpLossy(8, 7), null)
                .andExpect(status().isCreated()).andReturn();
        assertThat(json(webpResult).get("mime").asText()).isEqualTo("image/webp");
        assertThat(json(webpResult).get("width").asInt()).isEqualTo(8);
    }

    @Test
    void magicBytesWinOverSpoofedContentTypeAndMissingExtension() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("img-magic"));
        MvcResult spoofed = upload(owner, "image.png", "text/plain",
                TestImages.png(3, 3), null).andExpect(status().isCreated()).andReturn();
        assertThat(json(spoofed).get("mime").asText()).isEqualTo("image/png");

        MvcResult noExtension = upload(owner, "blob", "application/octet-stream",
                TestImages.png(3, 3), null).andExpect(status().isCreated()).andReturn();
        UUID fileId = UUID.fromString(json(noExtension).get("file_id").asText());
        assertThat(migrator().queryForObject(
                "SELECT filename FROM file.attachments WHERE id = ?", String.class, fileId))
                .isEqualTo("image.png");
    }

    @Test
    void rejectsWrongMagicAnimatedAndMismatchedExtension() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("img-reject"));
        long before = attachmentCount(owner.user().id());

        MvcResult gif = upload(owner, "x.gif", "image/gif", TestImages.gif(), null)
                .andExpect(status().isUnsupportedMediaType()).andReturn();
        assertThat(json(gif).get("code").asText()).isEqualTo("UNSUPPORTED_TYPE");
        upload(owner, "x.svg", "image/svg+xml", TestImages.svg(), null)
                .andExpect(status().isUnsupportedMediaType());
        MvcResult apng = upload(owner, "x.png", "image/png",
                TestImages.apng(4, 4), null)
                .andExpect(status().isUnprocessableEntity()).andReturn();
        assertThat(json(apng).get("code").asText()).isEqualTo("IMAGE_INVALID");
        upload(owner, "animated.webp", "image/webp",
                TestImages.webpExtended(4, 4, true), null)
                .andExpect(status().isUnprocessableEntity());
        MvcResult mismatch = upload(owner, "avatar.jpg", "image/jpeg",
                TestImages.png(4, 4), null)
                .andExpect(status().isUnprocessableEntity()).andReturn();
        assertThat(json(mismatch).get("code").asText()).isEqualTo("IMAGE_INVALID");

        assertThat(attachmentCount(owner.user().id())).isEqualTo(before);
    }

    @Test
    void rejectsTraversalNamesAndMissingFile() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("img-traversal"));
        long before = attachmentCount(owner.user().id());
        for (String name : new String[] {"../../etc/passwd.png", "..\\..\\evil.png",
                "a/b.png", "bad\u0000name.png"}) {
            MvcResult result = upload(owner, name, "image/png", TestImages.png(3, 3), null)
                    .andExpect(status().isBadRequest()).andReturn();
            assertThat(json(result).get("code").asText()).isEqualTo("VALIDATION_FAILED");
        }
        mockMvc.perform(authed(multipart("/api/v1/media/images"), owner))
                .andExpect(status().isBadRequest());
        assertThat(attachmentCount(owner.user().id())).isEqualTo(before);
    }

    @Test
    void enforcesFiveMebibyteLimit() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("img-size"));
        byte[] exact = TestImages.padded(TestImages.png(3, 3),
                (int) DirectImageUploadHandler.MAX_IMAGE_BYTES);
        upload(owner, "exact.png", "image/png", exact, null)
                .andExpect(status().isCreated());

        byte[] tooLarge = TestImages.padded(TestImages.png(3, 3),
                (int) DirectImageUploadHandler.MAX_IMAGE_BYTES + 1);
        MvcResult rejected = upload(owner, "big.png", "image/png", tooLarge, null)
                .andExpect(status().isPayloadTooLarge()).andReturn();
        assertThat(json(rejected).get("code").asText()).isEqualTo("FILE_TOO_LARGE");
    }

    @Test
    void unauthenticatedUploadIsRejected() throws Exception {
        mockMvc.perform(multipart("/api/v1/media/images")
                        .file(new MockMultipartFile("file", "a.png", "image/png",
                                TestImages.png(2, 2))))
                .andExpect(status().isUnauthorized());
    }

    @Test
    void chatBindingRequiresActiveMembershipAndEnablesCoverAndAvatar() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("img-chat-owner"));
        UUID chatId = owner.chat().id();
        UUID fileId = uploadAndGetId(owner, "channel.png", "image/png",
                TestImages.png(20, 12), chatId);

        Map<String, Object> row = migrator().queryForMap("""
                SELECT workspace_id, chat_id, upload_id, source, scan_status
                  FROM file.attachments WHERE id = ?
                """, fileId);
        assertThat(row.get("chat_id")).isEqualTo(chatId);
        assertThat(row.get("workspace_id")).isEqualTo(owner.workspace().id());

        MvcResult cover = mockMvc.perform(authed(post(
                        "/api/v1/chats/{chatId}/cover", chatId), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("file_id", fileId))))
                .andExpect(status().isOk()).andReturn();
        assertThat(json(cover).get("cover_file_id").asText()).isEqualTo(fileId.toString());

        MvcResult avatar = mockMvc.perform(authed(post(
                        "/api/v1/chats/{chatId}/avatar", chatId), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("file_id", fileId))))
                .andExpect(status().isOk()).andReturn();
        assertThat(json(avatar).get("avatar_file_id").asText()).isEqualTo(fileId.toString());
    }

    @Test
    void chatBindingRejectsNonMemberAndUnknownChat() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("img-chat-owner2"));
        SessionResponse other = devSession(uniqueDisplayName("img-chat-other"));
        long before = attachmentCount(other.user().id());

        upload(other, "stolen.png", "image/png", TestImages.png(4, 4), owner.chat().id())
                .andExpect(status().isNotFound());
        upload(owner, "missing.png", "image/png", TestImages.png(4, 4), UUID.randomUUID())
                .andExpect(status().isNotFound());
        assertThat(attachmentCount(other.user().id())).isEqualTo(before);
    }

    @Test
    void unboundImageCannotBeUsedAsChatCover() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("img-unbound"));
        UUID fileId = uploadAndGetId(owner, "loose.png", "image/png",
                TestImages.png(4, 4), null);
        mockMvc.perform(authed(post("/api/v1/chats/{chatId}/cover", owner.chat().id()), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("file_id", fileId))))
                .andExpect(status().isNotFound());
    }

    @Test
    void uploadedImageSetsUserAvatarAndWorkspaceLogo() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("img-avatar-logo"));
        UUID avatar = uploadAndGetId(owner, "me.png", "image/png",
                TestImages.png(18, 18), null);

        MvcResult avatarResult = mockMvc.perform(authed(post("/api/v1/me/avatar"), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("file_id", avatar))))
                .andExpect(status().isOk()).andReturn();
        assertThat(json(avatarResult).get("avatar_url").asText())
                .isEqualTo("/api/v1/me/avatar");
        assertThat(migrator().queryForObject(
                "SELECT avatar_file_id FROM auth.users WHERE id = ?", UUID.class,
                owner.user().id())).isEqualTo(avatar);
        mockMvc.perform(authed(
                        org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                                .get("/api/v1/me/avatar"), owner))
                .andExpect(status().isFound())
                .andExpect(header().exists("Location"));

        UUID logo = uploadAndGetId(owner, "logo.png", "image/png",
                TestImages.png(32, 32), null);
        MvcResult logoResult = mockMvc.perform(authed(post(
                        "/api/v1/workspaces/{workspaceId}/avatar", owner.workspace().id()), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("file_id", logo))))
                .andExpect(status().isOk()).andReturn();
        assertThat(json(logoResult).get("logo_file_id").asText()).isEqualTo(logo.toString());
        assertThat(migrator().queryForObject(
                "SELECT logo_file_id FROM workspace.workspaces WHERE id = ?", UUID.class,
                owner.workspace().id())).isEqualTo(logo);
    }

    @Test
    void callerOwnedDirectImageCanBeLogoOfAnotherOwnedWorkspace() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("img-cross-ws"));
        UUID fileId = uploadAndGetId(owner, "logo.png", "image/png",
                TestImages.png(16, 16), null);

        MvcResult created = mockMvc.perform(authed(post("/api/v1/workspaces"), owner)
                        .header("Idempotency-Key", UUID.randomUUID().toString())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "name", "Второй воркспейс " + UUID.randomUUID(),
                                "security_mode", "MANAGED"))))
                .andExpect(status().isCreated()).andReturn();
        UUID secondWorkspace = UUID.fromString(json(created).get("id").asText());

        mockMvc.perform(authed(post("/api/v1/workspaces/{workspaceId}/avatar",
                        secondWorkspace), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("file_id", fileId))))
                .andExpect(status().isOk());
        assertThat(migrator().queryForObject(
                "SELECT logo_file_id FROM workspace.workspaces WHERE id = ?", UUID.class,
                secondWorkspace)).isEqualTo(fileId);
    }

    @Test
    void directImageCannotBecomeMessageAttachment() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("img-message"));
        UUID fileId = uploadAndGetId(owner, "chat.png", "image/png",
                TestImages.png(6, 6), owner.chat().id());

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("client_message_id", UUID.randomUUID().toString());
        body.put("type", "TEXT");
        body.put("text", "with direct image");
        body.put("attachment_ids", java.util.List.of(fileId));
        MvcResult result = mockMvc.perform(authed(post("/api/v1/chats/{chatId}/messages",
                        owner.chat().id()), owner)
                        .header("Idempotency-Key", UUID.randomUUID().toString())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(body)))
                .andReturn();
        assertThat(result.getResponse().getStatus()).isEqualTo(422);
        assertThat(json(result).get("code").asText()).isEqualTo("IMAGE_INVALID");
        assertThat(json(result).get("details").get("reason").asText())
                .isEqualTo("direct_image_not_bindable");
    }

    @Test
    void directImagesAreNotDeletedByUploadGc() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("img-gc"));
        UUID fileId = uploadAndGetId(owner, "keep.png", "image/png",
                TestImages.png(5, 5), null);
        String objectKey = migrator().queryForObject(
                "SELECT object_key FROM file.attachments WHERE id = ?", String.class, fileId);

        uploadGcHandler.gcUnboundAttachment(fileId);

        assertThat(migrator().queryForObject(
                "SELECT status FROM file.attachments WHERE id = ?", String.class, fileId))
                .isEqualTo("READY");
        assertThat(objectStorage.exists(objectKey)).isTrue();
    }

    @Test
    void schemaKeepsRlsAndSourceConstraints() {
        Map<String, Object> flags = migrator().queryForMap("""
                SELECT relrowsecurity, relforcerowsecurity FROM pg_class
                 WHERE oid = 'file.attachments'::regclass
                """);
        assertThat(flags.get("relrowsecurity")).isEqualTo(true);
        assertThat(flags.get("relforcerowsecurity")).isEqualTo(true);
        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM information_schema.columns
                 WHERE table_schema = 'file' AND table_name = 'attachments'
                   AND column_name IN ('source', 'chat_id', 'upload_id')
                """, Integer.class)).isEqualTo(3);
        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM pg_constraint
                 WHERE conrelid = 'file.attachments'::regclass
                   AND conname IN ('ck_attachments_source', 'ck_attachments_source_shape')
                """, Integer.class)).isEqualTo(2);
        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM pg_indexes
                 WHERE schemaname = 'file' AND indexname = 'ix_attachments_direct_image'
                """, Integer.class)).isEqualTo(1);
        // chat_id/upload_id became nullable for direct images only; the policy is unchanged.
        assertThat(migrator().queryForObject("""
                SELECT is_nullable FROM information_schema.columns
                 WHERE table_schema = 'file' AND table_name = 'attachments'
                   AND column_name = 'upload_id'
                """, String.class)).isEqualTo("YES");
    }

    // ---------------------------------------------------------------- helpers

    private org.springframework.test.web.servlet.ResultActions upload(
            SessionResponse session, String filename, String contentType, byte[] bytes,
            UUID chatId) throws Exception {
        MockMultipartHttpServletRequestBuilder builder =
                multipart("/api/v1/media/images");
        if (chatId != null) {
            builder.param("chat_id", chatId.toString());
        }
        builder.file(new MockMultipartFile("file", filename, contentType, bytes));
        return mockMvc.perform(authed(builder, session));
    }

    private UUID uploadAndGetId(SessionResponse session, String filename, String contentType,
                                byte[] bytes, UUID chatId) throws Exception {
        MvcResult result = upload(session, filename, contentType, bytes, chatId)
                .andExpect(status().isCreated()).andReturn();
        return UUID.fromString(json(result).get("file_id").asText());
    }

    private long attachmentCount(UUID userId) {
        Long count = migrator().queryForObject(
                "SELECT count(*) FROM file.attachments WHERE user_id = ?", Long.class, userId);
        return count == null ? 0 : count;
    }
}
