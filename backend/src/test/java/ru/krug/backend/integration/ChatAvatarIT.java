package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataAccessException;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.shared.application.model.IssuedToken;
import ru.krug.backend.shared.application.port.TokenIssuer;
import ru.krug.backend.support.FileUploadTestSupport;
import ru.krug.backend.support.OpenApiContract;

/**
 * Channel icons/avatars (P0-2 follow-up) and the cover apply-path regression.
 *
 * <p>Covers the contract shapes, chat-role authorization, attachment validation (same rules
 * as the cover: same chat, image, CLEAN/SKIPPED), the presigned {@code GET}, idempotency,
 * audit minimisation, soft-delete cleanup and the V45 schema/RLS/FK backstops. The last test
 * pins the cover behaviour of {@code PATCH /chats/{chatId}} and {@code POST
 * /chats/{chatId}/cover}: both must return the updated {@code Chat} and be visible in the
 * list.</p>
 */
@ActiveProfiles("test")
class ChatAvatarIT extends FileUploadTestSupport {

    private static final OpenApiContract CONTRACT = OpenApiContract.load();

    @org.springframework.beans.factory.annotation.Autowired
    private TokenIssuer tokenIssuer;

    @Test
    void ownerSetsReplacesReadsAndClearsTheChannelAvatar() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("p02-avatar-owner"));
        SessionResponse member = devSession(uniqueDisplayName("p02-avatar-member"));
        SessionResponse outsider = devSession(uniqueDisplayName("p02-avatar-outsider"));
        UUID workspaceId = owner.workspace().id();
        UUID chatId = owner.chat().id();
        joinWorkspace(owner, member);
        joinWorkspace(owner, outsider);
        member = scoped(member, workspaceId);
        outsider = scoped(outsider, workspaceId);

        UUID imageId = uploadImage(owner, chatId, "avatar.png");

        MvcResult set = postAvatar(owner, chatId, imageId)
                .andExpect(status().isOk()).andReturn();
        JsonNode body = json(set);
        CONTRACT.assertValid("Chat", body);
        assertThat(body.get("avatar_file_id").asText()).isEqualTo(imageId.toString());
        assertThat(avatarOf(chatId)).isEqualTo(imageId);
        assertThat(auditCount("chat.avatar.updated", chatId)).isEqualTo(1L);

        // The audit is metadata-only: the attachment id never appears in it.
        Map<String, Object> event = auditEvent("chat.avatar.updated", chatId);
        assertThat(String.valueOf(event.get("metadata")))
                .doesNotContain(imageId.toString());
        assertThat(String.valueOf(event.get("target_type"))).isEqualTo("chat");

        // The avatar is part of the chat/summary for every participant.
        JsonNode listed = itemInList(chatListIn(member, workspaceId), chatId);
        assertThat(listed).isNotNull();
        CONTRACT.assertValid("ChatSummary", listed);
        assertThat(listed.get("avatar_file_id").asText()).isEqualTo(imageId.toString());
        assertThat(listed.get("cover_file_id").isNull()).isTrue();

        // GET is a 302 to a short-lived presigned URL; the storage key is never exposed.
        MvcResult download = mockMvc.perform(authed(getAvatar(chatId), member))
                .andExpect(status().isFound())
                .andExpect(header().exists("Location"))
                .andReturn();
        String location = download.getResponse().getHeader("Location");
        assertThat(location).startsWith("memory://");
        assertThat(location).contains("?expires=");
        JsonNode avatar = json(download);
        CONTRACT.assertValid("ProfileAvatar", avatar);
        assertThat(avatar.get("url").asText()).isEqualTo(location);
        assertThat(avatar.get("expires_at").isNull()).isFalse();

        // Idempotent repeat: 200 and no second audit.
        postAvatar(owner, chatId, imageId).andExpect(status().isOk());
        assertThat(auditCount("chat.avatar.updated", chatId)).isEqualTo(1L);

        // A SKIPPED image is accepted as well and replaces the previous avatar.
        UUID skipped = attachment(owner.user().id(), workspaceId, chatId, "image/png",
                "SKIPPED", "READY");
        postAvatar(owner, chatId, skipped).andExpect(status().isOk());
        assertThat(avatarOf(chatId)).isEqualTo(skipped);
        assertThat(auditCount("chat.avatar.updated", chatId)).isEqualTo(2L);

        // Only a chat OWNER/ADMIN may change the icon; a participant cannot.
        assertForbidden(postAvatar(member, chatId, skipped));
        mockMvc.perform(authed(deleteAvatar(chatId), member))
                .andExpect(status().isForbidden());
        assertThat(avatarOf(chatId)).isEqualTo(skipped);

        // A workspace member who is not a participant cannot see a private chat or its
        // avatar (existence is hidden as 404, not disclosed as 403).
        UUID privateChatId = createPrivateChannel(owner, "avatar-private", member.user().id());
        assertNotFound(postAvatar(outsider, privateChatId, skipped));
        assertNotFound(mockMvc.perform(authed(deleteAvatar(privateChatId), outsider)));
        mockMvc.perform(authed(getAvatar(privateChatId), outsider))
                .andExpect(status().isNotFound());

        // DELETE is idempotent and audited only on a real removal.
        mockMvc.perform(authed(deleteAvatar(chatId), owner))
                .andExpect(status().isNoContent());
        assertThat(avatarOf(chatId)).isNull();
        assertThat(auditCount("chat.avatar.updated", chatId)).isEqualTo(3L);
        mockMvc.perform(authed(deleteAvatar(chatId), owner))
                .andExpect(status().isNoContent());
        assertThat(auditCount("chat.avatar.updated", chatId)).isEqualTo(3L);
        mockMvc.perform(authed(getAvatar(chatId), member))
                .andExpect(status().isNotFound());

        // DIRECT chats have no icon at all.
        UUID directId = createDirect(owner, member.user().id());
        MvcResult direct = postAvatar(owner, directId, skipped)
                .andExpect(status().isUnprocessableEntity()).andReturn();
        assertThat(json(direct).get("code").asText())
                .isEqualTo("CHAT_MEMBERSHIP_UNSUPPORTED");
        mockMvc.perform(authed(deleteAvatar(directId), owner))
                .andExpect(status().isUnprocessableEntity());
        mockMvc.perform(authed(getAvatar(directId), owner))
                .andExpect(status().isNotFound());
    }

    @Test
    void avatarRejectsNonImageForeignOtherChatAndNotReadyAttachments() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("p02-avatar-invalid"));
        SessionResponse member = devSession(uniqueDisplayName("p02-avatar-invalid-member"));
        SessionResponse otherTenant = devSession(uniqueDisplayName("p02-avatar-foreign"));
        UUID workspaceId = owner.workspace().id();
        UUID chatId = owner.chat().id();
        joinWorkspace(owner, member);
        member = scoped(member, workspaceId);

        // A real text upload through the normal file flow is not an image.
        JsonNode text = uploadFile(owner, chatId, "notes.txt", randomBytes(32), "text/plain");
        UUID textId = UUID.fromString(text.get("attachment_id").asText());
        MvcResult notImage = postAvatar(owner, chatId, textId)
                .andExpect(status().isUnprocessableEntity()).andReturn();
        assertThat(json(notImage).get("code").asText()).isEqualTo("CHAT_AVATAR_INVALID");
        assertThat(json(notImage).get("details").get("field").asText()).isEqualTo("file_id");
        assertThat(avatarOf(chatId)).isNull();

        // AV fails closed: PENDING is 409, INFECTED is 423.
        UUID pending = attachment(owner.user().id(), workspaceId, chatId, "image/png",
                "PENDING", "READY");
        MvcResult notReady = postAvatar(owner, chatId, pending)
                .andExpect(status().isConflict()).andReturn();
        assertThat(json(notReady).get("code").asText()).isEqualTo("ATTACHMENT_NOT_READY");

        UUID infected = attachment(owner.user().id(), workspaceId, chatId, "image/png",
                "INFECTED", "READY");
        MvcResult quarantined = postAvatar(owner, chatId, infected)
                .andExpect(status().isLocked()).andReturn();
        assertThat(json(quarantined).get("code").asText())
                .isEqualTo("ATTACHMENT_QUARANTINED");
        assertThat(avatarOf(chatId)).isNull();

        // An image of another chat is hidden as 404, even for the chat OWNER.
        UUID otherChat = createPrivateChannel(owner, "avatar-other", member.user().id());
        UUID otherImage = uploadImage(owner, otherChat, "other.png");
        assertNotFound(postAvatar(owner, chatId, otherImage));
        assertNotFound(postAvatar(owner, chatId, UUID.randomUUID()));

        // A cross-tenant attachment id is invisible as well.
        JsonNode foreignSessionChat = uploadFile(otherTenant, otherTenant.chat().id(),
                "foreign.png", randomBytes(48), "image/png");
        UUID foreignImage = UUID.fromString(foreignSessionChat.get("attachment_id").asText());
        assertNotFound(postAvatar(owner, chatId, foreignImage));

        // None of the rejected attempts changed the chat or wrote an audit event.
        assertThat(avatarOf(chatId)).isNull();
        assertThat(auditCount("chat.avatar.updated", chatId)).isZero();

        // A malformed body is rejected before any application logic.
        mockMvc.perform(authed(post("/api/v1/chats/{chatId}/avatar", chatId), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{}"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void avatarSchemaRlsAndSoftDeleteBackstops() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("p02-avatar-schema"));
        SessionResponse member = devSession(uniqueDisplayName("p02-avatar-schema-member"));
        SessionResponse otherTenant = devSession(uniqueDisplayName("p02-avatar-schema-other"));
        UUID workspaceId = owner.workspace().id();
        UUID chatId = owner.chat().id();
        joinWorkspace(owner, member);
        member = scoped(member, workspaceId);

        UUID imageId = uploadImage(owner, chatId, "avatar-schema.png");
        postAvatar(owner, chatId, imageId).andExpect(status().isOk());

        assertThat(columnExists("chat", "chats", "avatar_file_id")).isTrue();
        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM pg_constraint WHERE conname = 'fk_chats_avatar_file'
                """, Long.class)).isEqualTo(1L);

        // chat.chats keeps FORCE RLS and the table-level grants the new column inherits.
        assertThat(migrator().queryForObject("""
                SELECT relrowsecurity AND relforcerowsecurity
                  FROM pg_class WHERE oid = 'chat.chats'::regclass
                """, Boolean.class)).isTrue();
        assertThat(migrator().queryForObject("""
                SELECT has_column_privilege('krug_app', 'chat.chats', 'avatar_file_id',
                                            'SELECT')
                   AND has_column_privilege('krug_app', 'chat.chats', 'avatar_file_id',
                                            'UPDATE')
                """, Boolean.class)).isTrue();

        // The FK rejects a dangling attachment id even on a superuser connection.
        assertThatThrownBy(() -> migrator().update(
                "UPDATE chat.chats SET avatar_file_id = ? WHERE id = ?",
                UUID.randomUUID(), chatId)).isInstanceOf(DataAccessException.class);
        assertThat(avatarOf(chatId)).isEqualTo(imageId);

        // Cross-tenant invisibility of the referenced attachment.
        Long visible = inTenant(otherTenant.user().id(), otherTenant.workspace().id(), () ->
                jdbc.queryForObject("""
                        SELECT count(*) FROM file.attachments WHERE id = ?
                        """, Long.class, imageId));
        assertThat(visible).isZero();

        // Soft delete clears the avatar with the chat; the attachment row is not deleted.
        mockMvc.perform(authed(delete("/api/v1/chats/{chatId}", chatId), owner))
                .andExpect(status().isNoContent());
        assertThat(avatarOf(chatId)).isNull();
        assertThat(migrator().queryForObject(
                "SELECT deleted_at FROM chat.chats WHERE id = ?",
                java.time.Instant.class, chatId)).isNotNull();
        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM file.attachments WHERE id = ? AND deleted_at IS NULL
                """, Long.class, imageId)).isEqualTo(1L);
        mockMvc.perform(authed(getAvatar(chatId), member))
                .andExpect(status().isNotFound());
    }

    @Test
    void coverSetThroughPatchAndCoverEndpointAppearsInTheChatAndList() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("p02-cover-apply-owner"));
        SessionResponse member = devSession(uniqueDisplayName("p02-cover-apply-member"));
        UUID workspaceId = owner.workspace().id();
        UUID chatId = owner.chat().id();
        joinWorkspace(owner, member);
        member = scoped(member, workspaceId);

        UUID first = uploadImage(owner, chatId, "cover-patch.png");
        UUID second = uploadImage(owner, chatId, "cover-post.png");
        UUID avatar = uploadImage(owner, chatId, "cover-avatar.png");
        postAvatar(owner, chatId, avatar).andExpect(status().isOk());

        // Path 1: PATCH /chats/{chatId} with cover_file_id.
        MvcResult patched = patchChat(owner, chatId, Map.of("cover_file_id", first.toString()))
                .andExpect(status().isOk()).andReturn();
        JsonNode patchedChat = json(patched);
        CONTRACT.assertValid("Chat", patchedChat);
        assertThat(patchedChat.get("cover_file_id").asText()).isEqualTo(first.toString());
        assertThat(patchedChat.get("avatar_file_id").asText()).isEqualTo(avatar.toString());
        assertThat(coverFileId(chatId)).isEqualTo(first);
        JsonNode patchedSummary = itemInList(chatListIn(member, workspaceId), chatId);
        CONTRACT.assertValid("ChatSummary", patchedSummary);
        assertThat(patchedSummary.get("cover_file_id").asText()).isEqualTo(first.toString());
        assertThat(patchedSummary.get("avatar_file_id").asText()).isEqualTo(avatar.toString());

        Map<String, Object> patchEvent = auditEvent("chat.updated", chatId);
        JsonNode patchMetadata = objectMapper.readTree(
                String.valueOf(patchEvent.get("metadata")));
        assertThat(patchMetadata.get("fields")).extracting(JsonNode::asText)
                .containsExactly("cover_file_id");
        assertThat(String.valueOf(patchEvent.get("metadata")))
                .doesNotContain(first.toString());

        // Path 2: POST /chats/{chatId}/cover replaces it and returns the updated Chat.
        MvcResult posted = postCover(owner, chatId, second)
                .andExpect(status().isOk()).andReturn();
        JsonNode postedChat = json(posted);
        CONTRACT.assertValid("Chat", postedChat);
        assertThat(postedChat.get("cover_file_id").asText()).isEqualTo(second.toString());
        assertThat(postedChat.get("avatar_file_id").asText()).isEqualTo(avatar.toString());
        assertThat(coverFileId(chatId)).isEqualTo(second);
        JsonNode postedSummary = itemInList(chatListIn(member, workspaceId), chatId);
        CONTRACT.assertValid("ChatSummary", postedSummary);
        assertThat(postedSummary.get("cover_file_id").asText()).isEqualTo(second.toString());
        assertThat(postedSummary.get("avatar_file_id").asText()).isEqualTo(avatar.toString());
        assertThat(auditCount("chat.cover.updated", chatId)).isEqualTo(1L);

        // A later settings PATCH that does not touch the cover keeps both images.
        patchChat(owner, chatId, Map.of("read_only", true)).andExpect(status().isOk());
        JsonNode after = itemInList(chatListIn(member, workspaceId), chatId);
        assertThat(after.get("cover_file_id").asText()).isEqualTo(second.toString());
        assertThat(after.get("avatar_file_id").asText()).isEqualTo(avatar.toString());
    }

    // ---------------------------------------------------------------- HTTP helpers

    private JsonNode chatListIn(SessionResponse session, UUID workspaceId) throws Exception {
        MvcResult result = mockMvc.perform(authed(
                        get("/api/v1/workspaces/{workspaceId}/chats", workspaceId), session))
                .andExpect(status().isOk()).andReturn();
        return json(result);
    }

    private ResultActions postAvatar(SessionResponse session, UUID chatId, UUID fileId)
            throws Exception {
        return mockMvc.perform(authed(post("/api/v1/chats/{chatId}/avatar", chatId), session)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(Map.of("file_id", fileId.toString()))));
    }

    private MockHttpServletRequestBuilder getAvatar(UUID chatId) {
        return get("/api/v1/chats/{chatId}/avatar", chatId);
    }

    private MockHttpServletRequestBuilder deleteAvatar(UUID chatId) {
        return delete("/api/v1/chats/{chatId}/avatar", chatId);
    }

    private ResultActions postCover(SessionResponse session, UUID chatId, UUID fileId)
            throws Exception {
        return mockMvc.perform(authed(post("/api/v1/chats/{chatId}/cover", chatId), session)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(Map.of("file_id", fileId.toString()))));
    }

    private ResultActions patchChat(SessionResponse session, UUID chatId,
                                    Map<String, Object> body) throws Exception {
        return mockMvc.perform(authed(patch("/api/v1/chats/{chatId}", chatId), session)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(body)));
    }

    private UUID uploadImage(SessionResponse session, UUID chatId, String filename)
            throws Exception {
        JsonNode image = uploadFile(session, chatId, filename, randomBytes(64), "image/png");
        return UUID.fromString(image.get("attachment_id").asText());
    }

    private SessionResponse scoped(SessionResponse user, UUID workspaceId) {
        IssuedToken token = tokenIssuer.issue(user.user().id(), user.device().id(), workspaceId);
        return new SessionResponse(token.accessToken(), token.expiresAt(), user.user(),
                user.device(), user.workspace(), user.chat());
    }

    private void joinWorkspace(SessionResponse owner, SessionResponse user) throws Exception {
        mockMvc.perform(authed(post("/api/v1/workspaces/{workspaceId}/members",
                        owner.workspace().id()), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "email", emailOf(user.user().id()), "role", "MEMBER"))))
                .andExpect(status().isCreated());
    }

    private UUID createPrivateChannel(SessionResponse owner, String name, UUID... memberIds)
            throws Exception {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("type", "GROUP");
        body.put("name", "p02-avatar-" + name + "-" + UUID.randomUUID());
        body.put("visibility", "PRIVATE");
        body.put("member_ids", List.of(memberIds));
        MvcResult result = mockMvc.perform(authed(post(
                                "/api/v1/workspaces/{workspaceId}/chats",
                                owner.workspace().id()), owner)
                        .header("Idempotency-Key", UUID.randomUUID().toString())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(body)))
                .andExpect(status().isCreated()).andReturn();
        return UUID.fromString(json(result).get("id").asText());
    }

    private UUID createDirect(SessionResponse owner, UUID peerId) throws Exception {
        MvcResult result = mockMvc.perform(authed(post(
                                "/api/v1/workspaces/{workspaceId}/chats",
                                owner.workspace().id()), owner)
                        .header("Idempotency-Key", UUID.randomUUID().toString())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "type", "DIRECT", "peer_id", peerId.toString()))))
                .andExpect(status().isCreated()).andReturn();
        return UUID.fromString(json(result).get("id").asText());
    }

    private JsonNode itemInList(JsonNode list, UUID chatId) {
        for (JsonNode item : list.get("items")) {
            if (item.get("id").asText().equals(chatId.toString())) {
                return item;
            }
        }
        return null;
    }

    private void assertForbidden(ResultActions actions) throws Exception {
        MvcResult result = actions.andExpect(status().isForbidden()).andReturn();
        CONTRACT.assertValid("Error", json(result));
    }

    private void assertNotFound(ResultActions actions) throws Exception {
        MvcResult result = actions.andExpect(status().isNotFound()).andReturn();
        CONTRACT.assertValid("Error", json(result));
    }

    // ---------------------------------------------------------------- DB helpers

    private UUID avatarOf(UUID chatId) {
        return migrator().queryForObject(
                "SELECT avatar_file_id FROM chat.chats WHERE id = ?", UUID.class, chatId);
    }

    private UUID coverFileId(UUID chatId) {
        return migrator().queryForObject(
                "SELECT cover_file_id FROM chat.chats WHERE id = ?", UUID.class, chatId);
    }

    private String emailOf(UUID userId) {
        return migrator().queryForObject(
                "SELECT email::text FROM auth.users WHERE id = ?", String.class, userId);
    }

    private boolean columnExists(String schema, String table, String column) {
        return Boolean.TRUE.equals(migrator().queryForObject("""
                SELECT EXISTS (
                    SELECT 1 FROM information_schema.columns
                     WHERE table_schema = ? AND table_name = ? AND column_name = ?
                )
                """, Boolean.class, schema, table, column));
    }

    private long auditCount(String action, UUID targetId) {
        return migrator().queryForObject("""
                SELECT count(*) FROM audit.audit_events
                 WHERE action = ? AND target_id = ?
                """, Long.class, action, targetId);
    }

    private Map<String, Object> auditEvent(String action, UUID targetId) {
        return migrator().queryForMap("""
                SELECT actor_id, target_type, target_id, metadata::text AS metadata
                  FROM audit.audit_events
                 WHERE action = ? AND target_id = ?
                 ORDER BY created_at DESC, seq DESC
                 LIMIT 1
                """, action, targetId);
    }

    /**
     * Inserts a managed attachment directly, so SCANNING/INFECTED states that the dev scanner
     * never reaches in tests can still be exercised. Mirrors the real file-flow rows.
     */
    private UUID attachment(UUID userId, UUID workspaceId, UUID chatId, String mime,
                            String scanStatus, String status) {
        UUID uploadId = UUID.randomUUID();
        UUID attachmentId = UUID.randomUUID();
        String sha = "b".repeat(64);
        String objectKey = "p02/avatar/" + attachmentId;
        migrator().update("""
                INSERT INTO file.uploads
                       (id, workspace_id, chat_id, user_id, filename, mime_type, size_bytes,
                        sha256, status, part_size, total_parts, object_key, expires_at,
                        completed_at)
                VALUES (?, ?, ?, ?, 'avatar.png', ?, 16, ?, 'READY', 16, 1, ?,
                        now() + interval '1 hour', now())
                """, uploadId, workspaceId, chatId, userId, mime, sha, objectKey);
        String media = mime.startsWith("image/")
                ? "{\"kind\":\"IMAGE\",\"metadata_source\":\"CLIENT\"}"
                : "{\"kind\":\"FILE\",\"metadata_source\":\"CLIENT\"}";
        migrator().update("""
                INSERT INTO file.attachments
                       (id, workspace_id, chat_id, upload_id, user_id, filename, mime_type,
                        size_bytes, sha256, object_key, status, scan_status, media)
                VALUES (?, ?, ?, ?, ?, 'avatar.png', ?, 16, ?, ?, ?, ?, CAST(? AS jsonb))
                """, attachmentId, workspaceId, chatId, uploadId, userId, mime, sha, objectKey,
                status, scanStatus, media);
        return attachmentId;
    }
}
