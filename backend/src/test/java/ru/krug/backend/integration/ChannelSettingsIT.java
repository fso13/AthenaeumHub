package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
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
 * P0-2 (#80) channel settings: cover, read-only, visibility/join policy, per-role rights,
 * user-local archive, soft delete and pins.
 *
 * <p>Covers the contract shapes, chat-role authorization, the read-only/rights enforcement in
 * message send and poll creation, cover validation against the existing attachment pipeline,
 * archive isolation, delete/leave semantics, pin uniqueness/idempotency/limits/accessibility,
 * audit minimisation and the V41 RLS/FK/backstops.</p>
 */
@ActiveProfiles("test")
class ChannelSettingsIT extends FileUploadTestSupport {

    private static final OpenApiContract CONTRACT = OpenApiContract.load();

    @Autowired
    private TokenIssuer tokenIssuer;

    @AfterEach
    void restoreChatLimits() {
        migrator().update("""
                UPDATE ops.system_settings
                   SET max_chats_per_user = 100, max_chats_per_workspace = 1000
                 WHERE id = 1
                """);
    }

    @Test
    void ownerUpdatesChannelSettingsAndAuditHasOnlyFieldNames() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("p02-settings-owner"));
        SessionResponse member = devSession(uniqueDisplayName("p02-settings-member"));
        UUID workspaceId = owner.workspace().id();
        UUID chatId = owner.chat().id();
        joinWorkspace(owner, member);
        member = scoped(member, workspaceId);

        MvcResult updated = patchChat(owner, chatId, Map.of(
                        "name", "  Product   Channel ",
                        "read_only", true,
                        "visibility", "PRIVATE",
                        "join_policy", "INVITE_ONLY"))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode body = json(updated);
        CONTRACT.assertValid("Chat", body);
        assertThat(body.get("name").asText()).isEqualTo("Product Channel");
        assertThat(body.get("read_only").asBoolean()).isTrue();
        assertThat(body.get("visibility").asText()).isEqualTo("PRIVATE");
        assertThat(body.get("join_policy").asText()).isEqualTo("INVITE_ONLY");

        assertThat(chatColumn(chatId, "read_only")).isEqualTo(true);
        assertThat(chatColumn(chatId, "join_policy")).isEqualTo("INVITE_ONLY");
        assertThat(visibilityRow(chatId)).isEqualTo("PRIVATE");

        JsonNode summary = itemInList(json(chatListRaw(member, workspaceId, false)), chatId);
        assertThat(summary).isNotNull();
        CONTRACT.assertValid("ChatSummary", summary);
        assertThat(summary.get("read_only").asBoolean()).isTrue();
        assertThat(summary.get("join_policy").asText()).isEqualTo("INVITE_ONLY");

        Map<String, Object> event = auditEvent("chat.updated", chatId);
        JsonNode metadata = objectMapper.readTree(String.valueOf(event.get("metadata")));
        assertThat(metadata.get("fields")).extracting(JsonNode::asText)
                .containsExactlyInAnyOrder("name", "read_only", "visibility", "join_policy");
        assertThat(String.valueOf(event.get("metadata")))
                .doesNotContain("Product Channel")
                .doesNotContain("read_only\":true");

        // PUBLIC is channelled back to OPEN; sending only visibility=PUBLIC is accepted.
        MvcResult publicAgain = patchChat(owner, chatId, Map.of("visibility", "PUBLIC"))
                .andExpect(status().isOk()).andReturn();
        assertThat(json(publicAgain).get("visibility").asText()).isEqualTo("PUBLIC");
        assertThat(json(publicAgain).get("join_policy").asText()).isEqualTo("OPEN");

        // Incoherent PUBLIC + CLOSED is rejected without changing anything.
        MvcResult incoherent = patchChat(owner, chatId,
                Map.of("visibility", "PUBLIC", "join_policy", "CLOSED"))
                .andExpect(status().isUnprocessableEntity()).andReturn();
        assertThat(json(incoherent).get("code").asText()).isEqualTo("VALIDATION_FAILED");
        assertThat(json(incoherent).get("details").get("field").asText())
                .isEqualTo("join_policy");
        assertThat(chatColumn(chatId, "join_policy")).isEqualTo("OPEN");

        // Structural settings are chat OWNER/ADMIN only; a MEMBER gets 403 even though they
        // are a workspace member.
        assertForbidden(patchChat(member, chatId, Map.of("read_only", true)));
        assertForbidden(patchChat(member, chatId, Map.of("visibility", "PRIVATE")));

        // DIRECT has no channel settings, and an empty patch is rejected.
        UUID directId = createDirect(owner, member.user().id());
        MvcResult direct = patchChat(owner, directId, Map.of("read_only", true))
                .andExpect(status().isUnprocessableEntity()).andReturn();
        assertThat(json(direct).get("code").asText())
                .isEqualTo("CHAT_MEMBERSHIP_UNSUPPORTED");
        assertValidationError(patchChat(owner, chatId, Map.of()), "empty_patch");
    }

    @Test
    void permissionsMatrixDefaultsPatchesAndAuthorization() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("p02-perms-owner"));
        SessionResponse member = devSession(uniqueDisplayName("p02-perms-member"));
        UUID workspaceId = owner.workspace().id();
        UUID chatId = owner.chat().id();
        joinWorkspace(owner, member);
        member = scoped(member, workspaceId);

        MvcResult defaultsResult = mockMvc.perform(authed(getPermissions(chatId), owner))
                .andExpect(status().isOk()).andReturn();
        JsonNode defaults = json(defaultsResult);
        CONTRACT.assertValid("ChatPermissions", defaults);
        assertAllTrue(defaults.get("owner"));
        assertAllTrue(defaults.get("admin"));
        assertThat(defaults.get("moderator").get("pin_messages").asBoolean()).isTrue();
        assertThat(defaults.get("moderator").get("invite_members").asBoolean()).isTrue();
        assertThat(defaults.get("moderator").get("change_info").asBoolean()).isFalse();
        assertThat(defaults.get("member").get("post_messages").asBoolean()).isTrue();
        assertThat(defaults.get("member").get("invite_members").asBoolean()).isFalse();
        assertThat(defaults.get("member").get("pin_messages").asBoolean()).isFalse();
        assertThat(defaults.get("guest").get("create_polls").asBoolean()).isFalse();

        // A participant can read the matrix; a non-participant cannot learn the chat.
        mockMvc.perform(authed(getPermissions(chatId), member)).andExpect(status().isOk());

        MvcResult patched = patchPermissions(owner, chatId, Map.of(
                        "admin", Map.of("post_messages", false),
                        "moderator", Map.of("pin_messages", false, "change_info", true),
                        "member", Map.of("invite_members", true, "pin_messages", true)))
                .andExpect(status().isOk()).andReturn();
        JsonNode matrix = json(patched);
        CONTRACT.assertValid("ChatPermissions", matrix);
        assertThat(matrix.get("admin").get("post_messages").asBoolean()).isFalse();
        assertThat(matrix.get("moderator").get("pin_messages").asBoolean()).isFalse();
        assertThat(matrix.get("moderator").get("change_info").asBoolean()).isTrue();
        assertThat(matrix.get("member").get("invite_members").asBoolean()).isTrue();
        assertThat(matrix.get("member").get("pin_messages").asBoolean()).isTrue();
        assertThat(matrix.get("owner").get("post_messages").asBoolean()).isTrue();

        Map<String, Object> event = auditEvent("chat.permissions.updated", chatId);
        JsonNode metadata = objectMapper.readTree(String.valueOf(event.get("metadata")));
        assertThat(metadata.get("roles")).extracting(JsonNode::asText)
                .containsExactlyInAnyOrder("ADMIN", "MODERATOR", "MEMBER");
        assertThat(metadata.get("permissions")).extracting(JsonNode::asText)
                .containsExactlyInAnyOrder("post_messages", "pin_messages", "change_info",
                        "invite_members");

        // The matrix is chat OWNER/ADMIN only; OWNER rights are fixed; input is validated.
        assertForbidden(patchPermissions(member, chatId,
                Map.of("member", Map.of("post_messages", false))));
        assertValidationError(patchPermissions(owner, chatId,
                Map.of("owner", Map.of("post_messages", false))), "owner_permissions_fixed");
        assertValidationError(patchPermissions(owner, chatId, Map.of()), "empty_patch");
        // A typed DTO ignores an unknown JSON role key, so the request is an empty patch;
        // the role-literal guard itself is unit-tested in ChannelSettingsDomainTest.
        assertValidationError(patchPermissions(owner, chatId,
                Map.of("SUPERUSER", Map.of("post_messages", true))), "empty_patch");

        UUID directId = createDirect(owner, member.user().id());
        MvcResult direct = mockMvc.perform(authed(getPermissions(directId), owner))
                .andExpect(status().isUnprocessableEntity()).andReturn();
        assertThat(json(direct).get("code").asText())
                .isEqualTo("CHAT_MEMBERSHIP_UNSUPPORTED");
    }

    @Test
    void readOnlyAndRightsBlockWritesWhileReplaysStillWork() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("p02-write-owner"));
        SessionResponse member = devSession(uniqueDisplayName("p02-write-member"));
        UUID workspaceId = owner.workspace().id();
        UUID chatId = owner.chat().id();
        joinWorkspace(owner, member);
        member = scoped(member, workspaceId);

        // A first message establishes the replay baseline.
        String key = UUID.randomUUID().toString();
        String clientId = UUID.randomUUID().toString();
        mockMvc.perform(sendWithKeys(member, chatId, key, clientId, "before read-only"))
                .andExpect(status().isCreated());

        patchChat(owner, chatId, Map.of("read_only", true)).andExpect(status().isOk());

        MvcResult blocked = send(member, chatId, "blocked")
                .andExpect(status().isForbidden()).andReturn();
        assertThat(json(blocked).get("code").asText()).isEqualTo("CHAT_READ_ONLY");
        assertThat(messageCount(chatId)).isEqualTo(1);

        // The chat OWNER may still write; a replay of the pre-read-only send is untouched.
        send(owner, chatId, "owner owns the channel").andExpect(status().isCreated());
        mockMvc.perform(sendWithKeys(member, chatId, key, clientId, "before read-only"))
                .andExpect(status().isCreated());
        assertThat(messageCount(chatId)).isEqualTo(2);

        // Poll creation is a write and is blocked by read-only too.
        mockMvc.perform(authed(patchPlugin(chatId, "polls"), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("enabled", true))))
                .andExpect(status().isOk());
        MvcResult pollBlocked = postPoll(member, chatId)
                .andExpect(status().isForbidden()).andReturn();
        assertThat(json(pollBlocked).get("code").asText()).isEqualTo("CHAT_READ_ONLY");

        // Turning read-only off restores writes; the per-role matrix can then deny them.
        patchChat(owner, chatId, Map.of("read_only", false)).andExpect(status().isOk());
        send(member, chatId, "allowed again").andExpect(status().isCreated());

        patchPermissions(owner, chatId,
                Map.of("member", Map.of("post_messages", false)))
                .andExpect(status().isOk());
        MvcResult denied = send(member, chatId, "denied by matrix")
                .andExpect(status().isForbidden()).andReturn();
        assertThat(json(denied).get("code").asText()).isEqualTo("CHAT_PERMISSION_DENIED");
        assertThat(json(denied).get("details").get("permission").asText())
                .isEqualTo("post_messages");

        patchPermissions(owner, chatId, Map.of("member", Map.of("create_polls", false)))
                .andExpect(status().isOk());
        MvcResult pollDenied = postPoll(member, chatId)
                .andExpect(status().isForbidden()).andReturn();
        assertThat(json(pollDenied).get("code").asText())
                .isEqualTo("CHAT_PERMISSION_DENIED");

        // The OWNER is never blocked by the matrix (fixed all-true row).
        patchPermissions(owner, chatId,
                Map.of("admin", Map.of("post_messages", false))).andExpect(status().isOk());
        send(owner, chatId, "owner still posts").andExpect(status().isCreated());
    }

    @Test
    void coverReferencesACleanImageFromTheSameChat() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("p02-cover-owner"));
        SessionResponse member = devSession(uniqueDisplayName("p02-cover-member"));
        UUID workspaceId = owner.workspace().id();
        UUID chatId = owner.chat().id();
        joinWorkspace(owner, member);
        member = scoped(member, workspaceId);

        JsonNode image = uploadFile(owner, chatId, "cover.png", randomBytes(64), "image/png");
        UUID imageId = UUID.fromString(image.get("attachment_id").asText());

        MvcResult set = mockMvc.perform(authed(postCover(chatId), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(
                                Map.of("file_id", imageId.toString()))))
                .andExpect(status().isOk()).andReturn();
        JsonNode body = json(set);
        CONTRACT.assertValid("Chat", body);
        assertThat(body.get("cover_file_id").asText()).isEqualTo(imageId.toString());
        assertThat(coverFileId(chatId)).isEqualTo(imageId);

        MvcResult listed = chatListRaw(member, workspaceId, false);
        assertThat(itemInList(json(listed), chatId).get("cover_file_id").asText())
                .isEqualTo(imageId.toString());

        // Idempotent repeat: 200 and no second audit.
        mockMvc.perform(authed(postCover(chatId), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(
                                Map.of("file_id", imageId.toString()))))
                .andExpect(status().isOk());
        assertThat(auditCount("chat.cover.updated", chatId)).isEqualTo(1);

        // Non-image, unknown and other-chat attachments are rejected without a cover change.
        JsonNode text = uploadFile(owner, chatId, "notes.txt", randomBytes(32), "text/plain");
        UUID textId = UUID.fromString(text.get("attachment_id").asText());
        MvcResult notImage = postCover(owner, chatId, textId)
                .andExpect(status().isUnprocessableEntity()).andReturn();
        assertThat(json(notImage).get("code").asText()).isEqualTo("CHAT_COVER_INVALID");

        UUID otherChat = createPrivateChannel(owner, "cover-other", member.user().id());
        JsonNode otherImage = uploadFile(owner, otherChat, "other.png", randomBytes(64),
                "image/png");
        UUID otherImageId = UUID.fromString(otherImage.get("attachment_id").asText());
        postCover(owner, chatId, otherImageId).andExpect(status().isNotFound());
        postCover(owner, chatId, UUID.randomUUID()).andExpect(status().isNotFound());
        assertThat(coverFileId(chatId)).isEqualTo(imageId);

        // A regular participant cannot set or clear the cover.
        assertForbidden(postCover(member, chatId, imageId));
        mockMvc.perform(authed(deleteCover(chatId), member))
                .andExpect(status().isForbidden());

        // Clearing is idempotent and audited only once.
        mockMvc.perform(authed(deleteCover(chatId), owner))
                .andExpect(status().isNoContent());
        mockMvc.perform(authed(deleteCover(chatId), owner))
                .andExpect(status().isNoContent());
        assertThat(coverFileId(chatId)).isNull();
        assertThat(auditCount("chat.cover.updated", chatId)).isEqualTo(2);

    }

    @Test
    void archiveIsUserLocalAndHasItsOwnList() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("p02-archive-owner"));
        SessionResponse member = devSession(uniqueDisplayName("p02-archive-member"));
        SessionResponse outsider = devSession(uniqueDisplayName("p02-archive-outsider"));
        UUID workspaceId = owner.workspace().id();
        UUID chatId = owner.chat().id();
        joinWorkspace(owner, member);
        member = scoped(member, workspaceId);
        outsider = scoped(outsider, workspaceId);

        assertThat(itemInList(json(chatListRaw(owner, workspaceId, false)), chatId)).isNotNull();

        mockMvc.perform(authed(archive(chatId), owner))
                .andExpect(status().isNoContent());
        mockMvc.perform(authed(archive(chatId), owner))
                .andExpect(status().isNoContent());

        assertThat(itemInList(json(chatListRaw(owner, workspaceId, false)), chatId)).isNull();
        JsonNode archived = itemInList(json(chatListRaw(owner, workspaceId, true)), chatId);
        assertThat(archived).isNotNull();
        CONTRACT.assertValid("ChatSummary", archived);
        assertThat(archived.get("archived").asBoolean()).isTrue();

        // Another participant's view is untouched: the archive is user-local.
        assertThat(itemInList(json(chatListRaw(member, workspaceId, false)), chatId)).isNotNull();
        assertThat(json(chatListRaw(member, workspaceId, true)).get("items")).isEmpty();

        mockMvc.perform(authed(unarchive(chatId), owner))
                .andExpect(status().isNoContent());
        mockMvc.perform(authed(unarchive(chatId), owner))
                .andExpect(status().isNoContent());
        assertThat(itemInList(json(chatListRaw(owner, workspaceId, false)), chatId)).isNotNull();
        assertThat(json(chatListRaw(owner, workspaceId, true)).get("items")).isEmpty();

        // A non-member cannot archive a channel they cannot see; DIRECT chats are archivable.
        mockMvc.perform(authed(archive(chatId), outsider))
                .andExpect(status().isNotFound());
        UUID directId = createDirect(owner, member.user().id());
        mockMvc.perform(authed(archive(directId), owner))
                .andExpect(status().isNoContent());
        assertThat(itemInList(json(chatListRaw(owner, workspaceId, false)), directId)).isNull();
        assertThat(itemInList(json(chatListRaw(owner, workspaceId, true)), directId)).isNotNull();
    }

    @Test
    void deleteIsOwnerOnlySoftAndClearsTheCover() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("p02-delete-owner"));
        SessionResponse member = devSession(uniqueDisplayName("p02-delete-member"));
        SessionResponse chatAdmin = devSession(uniqueDisplayName("p02-delete-admin"));
        SessionResponse workspaceAdmin = devSession(uniqueDisplayName("p02-delete-wsadmin"));
        UUID workspaceId = owner.workspace().id();
        joinWorkspace(owner, member);
        joinWorkspace(owner, chatAdmin);
        addWorkspaceMember(owner, workspaceId, workspaceAdmin.user().id(), "ADMIN");
        member = scoped(member, workspaceId);
        chatAdmin = scoped(chatAdmin, workspaceId);
        workspaceAdmin = scoped(workspaceAdmin, workspaceId);

        UUID chatId = createPrivateChannel(owner, "delete", member.user().id(),
                chatAdmin.user().id());
        changeRole(owner, chatId, chatAdmin.user().id(), "ADMIN").andExpect(status().isOk());
        JsonNode image = uploadFile(owner, chatId, "delete-cover.png", randomBytes(48),
                "image/png");
        UUID imageId = UUID.fromString(image.get("attachment_id").asText());
        postCover(owner, chatId, imageId).andExpect(status().isOk());

        // A regular MEMBER and a chat ADMIN cannot delete; a workspace ADMIN who is not a
        // participant cannot even see the channel.
        mockMvc.perform(authed(deleteChat(chatId), member)).andExpect(status().isForbidden());
        mockMvc.perform(authed(deleteChat(chatId), chatAdmin))
                .andExpect(status().isForbidden());
        mockMvc.perform(authed(deleteChat(chatId), workspaceAdmin))
                .andExpect(status().isNotFound());

        mockMvc.perform(authed(deleteChat(chatId), owner))
                .andExpect(status().isNoContent());
        assertThat(deletedAt(chatId)).isNotNull();
        assertThat(coverFileId(chatId)).isNull();

        // The channel is hidden from lists, access and repeated deletes.
        assertThat(itemInList(json(chatListRaw(member, workspaceId, false)), chatId)).isNull();
        mockMvc.perform(authed(deleteChat(chatId), owner)).andExpect(status().isNotFound());
        send(member, chatId, "gone").andExpect(status().isNotFound());
        assertThat(auditCount("chat.deleted", chatId)).isEqualTo(1);

        // Leaving is unchanged and DIRECT chats cannot be deleted as channels.
        UUID directId = createDirect(owner, member.user().id());
        MvcResult direct = mockMvc.perform(authed(deleteChat(directId), owner))
                .andExpect(status().isUnprocessableEntity()).andReturn();
        assertThat(json(direct).get("code").asText())
                .isEqualTo("CHAT_MEMBERSHIP_UNSUPPORTED");
        mockMvc.perform(authed(post("/api/v1/chats/{chatId}/leave", directId), member))
                .andExpect(status().isUnprocessableEntity());
    }

    @Test
    void pinsAreUniqueAccessiblePermissionedAndLimited() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("p02-pins-owner"));
        SessionResponse moderator = devSession(uniqueDisplayName("p02-pins-mod"));
        SessionResponse member = devSession(uniqueDisplayName("p02-pins-member"));
        UUID workspaceId = owner.workspace().id();
        joinWorkspace(owner, moderator);
        joinWorkspace(owner, member);
        moderator = scoped(moderator, workspaceId);
        member = scoped(member, workspaceId);
        UUID chatId = createPrivateChannel(owner, "pins", moderator.user().id(),
                member.user().id());
        changeRole(owner, chatId, moderator.user().id(), "MODERATOR")
                .andExpect(status().isOk());

        UUID first = messageId(sendMessage(owner, chatId, UUID.randomUUID().toString(),
                UUID.randomUUID().toString(), "first message"));
        UUID second = messageId(sendMessage(owner, chatId, UUID.randomUUID().toString(),
                UUID.randomUUID().toString(), "second message"));

        MvcResult pinned = mockMvc.perform(authed(postPins(chatId), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(
                                Map.of("message_id", first.toString()))))
                .andExpect(status().isCreated()).andReturn();
        JsonNode pin = json(pinned);
        CONTRACT.assertValid("ChatPin", pin);
        assertThat(pin.get("message_id").asText()).isEqualTo(first.toString());
        assertThat(pin.get("pinned_by").asText()).isEqualTo(owner.user().id().toString());
        assertThat(pin.get("pinned_at").asText()).isNotBlank();

        // Unique + idempotent: 200, one row, one audit event.
        mockMvc.perform(authed(postPins(chatId), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(
                                Map.of("message_id", first.toString()))))
                .andExpect(status().isOk());
        assertThat(pinCount(chatId)).isEqualTo(1);
        assertThat(auditCount("chat.pin.added", chatId)).isEqualTo(1);

        // A regular MEMBER may list but not pin by default; MODERATOR may pin.
        MvcResult list = mockMvc.perform(authed(getPins(chatId), member))
                .andExpect(status().isOk()).andReturn();
        JsonNode listBody = json(list);
        CONTRACT.assertValid("ChatPinList", listBody);
        assertThat(listBody.get("items")).hasSize(1);
        assertThat(list.getResponse().getContentAsString())
                .doesNotContain("first message")
                .doesNotContain("body")
                .doesNotContain("ciphertext");
        mockMvc.perform(authed(postPins(chatId), member)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(
                                Map.of("message_id", second.toString()))))
                .andExpect(status().isForbidden());
        mockMvc.perform(authed(postPins(chatId), moderator)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(
                                Map.of("message_id", second.toString()))))
                .andExpect(status().isCreated());

        // The matrix can grant pin_messages to MEMBER.
        patchPermissions(owner, chatId, Map.of("member", Map.of("pin_messages", true)))
                .andExpect(status().isOk());
        assertThat(messageCount(chatId)).isEqualTo(2);

        // Unknown and other-chat messages are rejected.
        postPin(owner, chatId, UUID.randomUUID()).andExpect(status().isNotFound());
        UUID foreign = messageId(sendMessage(owner, owner.chat().id(),
                UUID.randomUUID().toString(), UUID.randomUUID().toString(), "elsewhere"));
        postPin(owner, chatId, foreign).andExpect(status().isNotFound());

        // Unpin is idempotent and audited once.
        mockMvc.perform(authed(deletePin(chatId, second), moderator))
                .andExpect(status().isNoContent());
        mockMvc.perform(authed(deletePin(chatId, second), moderator))
                .andExpect(status().isNoContent());
        assertThat(auditCount("chat.pin.removed", chatId)).isEqualTo(1);

        // A pinned message deleted for all disappears from the list; the pin can be cleared.
        mockMvc.perform(authed(delete("/api/v1/chats/{chatId}/messages/{messageId}",
                chatId, first).param("scope", "all"), owner))
                .andExpect(status().isNoContent());
        assertThat(json(mockMvc.perform(authed(getPins(chatId), owner))
                .andExpect(status().isOk()).andReturn()).get("items")).isEmpty();
        mockMvc.perform(authed(deletePin(chatId, first), owner))
                .andExpect(status().isNoContent());

        // At most 50 pins per channel (metadata rows are enough to exercise the cap).
        for (int i = 0; i < 50; i++) {
            migrator().update("""
                    INSERT INTO chat.chat_pins
                        (chat_id, message_id, workspace_id, pinned_by, pinned_at)
                    VALUES (?, ?, ?, ?, now())
                    ON CONFLICT DO NOTHING
                    """, chatId, UUID.randomUUID(), workspaceId, owner.user().id());
        }
        MvcResult limit = postPin(owner, chatId, second).andExpect(status().isConflict())
                .andReturn();
        assertThat(json(limit).get("code").asText()).isEqualTo("CHAT_PIN_LIMIT");

        // DIRECT has no channel pins.
        UUID directId = createDirect(owner, member.user().id());
        MvcResult direct = mockMvc.perform(authed(getPins(directId), owner))
                .andExpect(status().isUnprocessableEntity()).andReturn();
        assertThat(json(direct).get("code").asText())
                .isEqualTo("CHAT_MEMBERSHIP_UNSUPPORTED");
    }

    @Test
    void changeInfoAndInviteRightsDelegateChannelManagement() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("p02-deleg-owner"));
        SessionResponse member = devSession(uniqueDisplayName("p02-deleg-member"));
        SessionResponse moderator = devSession(uniqueDisplayName("p02-deleg-mod"));
        SessionResponse candidate = devSession(uniqueDisplayName("p02-deleg-candidate"));
        UUID workspaceId = owner.workspace().id();
        joinWorkspace(owner, member);
        joinWorkspace(owner, moderator);
        joinWorkspace(owner, candidate);
        member = scoped(member, workspaceId);
        moderator = scoped(moderator, workspaceId);
        candidate = scoped(candidate, workspaceId);
        UUID chatId = createPrivateChannel(owner, "delegate", member.user().id(),
                moderator.user().id());
        changeRole(owner, chatId, moderator.user().id(), "MODERATOR")
                .andExpect(status().isOk());

        // change_info is off by default: a MEMBER cannot edit the name.
        assertForbidden(patchChat(member, chatId, Map.of("name", "member-name")));
        patchPermissions(owner, chatId, Map.of("member", Map.of("change_info", true)))
                .andExpect(status().isOk());
        MvcResult renamed = patchChat(member, chatId, Map.of("name", "member-name"))
                .andExpect(status().isOk()).andReturn();
        assertThat(json(renamed).get("name").asText()).isEqualTo("member-name");
        // ... but change_info never grants structural settings.
        assertForbidden(patchChat(member, chatId, Map.of("read_only", true)));

        // invite_members: MODERATOR default true; MEMBER default false.
        createInvite(moderator, chatId, Map.of("role", "MEMBER"))
                .andExpect(status().isCreated());
        mockMvc.perform(authed(postInvite(chatId), member))
                .andExpect(status().isForbidden());

        patchPermissions(owner, chatId, Map.of("member", Map.of("invite_members", true)))
                .andExpect(status().isOk());
        createInvite(member, chatId, Map.of("role", "MEMBER"))
                .andExpect(status().isCreated());

        // A low role with invite_members cannot escalate the role ceiling.
        MvcResult escalation = addMember(member, chatId, candidate.user().id(), "ADMIN")
                .andExpect(status().isForbidden()).andReturn();
        assertThat(json(escalation).get("code").asText())
                .isEqualTo("ROLE_CHANGE_FORBIDDEN");
        addMember(member, chatId, candidate.user().id(), "MEMBER")
                .andExpect(status().isCreated());

        // Revoking the right takes effect immediately, including for a MODERATOR.
        patchPermissions(owner, chatId,
                Map.of("moderator", Map.of("invite_members", false)))
                .andExpect(status().isOk());
        mockMvc.perform(authed(postInvite(chatId), moderator))
                .andExpect(status().isForbidden());
    }

    @Test
    void joinPolicyClosedRejectsAcceptsAndPublicSwitchAddsMembers() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("p02-join-owner"));
        SessionResponse member = devSession(uniqueDisplayName("p02-join-member"));
        SessionResponse late = devSession(uniqueDisplayName("p02-join-late"));
        SessionResponse late2 = devSession(uniqueDisplayName("p02-join-late2"));
        UUID workspaceId = owner.workspace().id();
        joinWorkspace(owner, member);
        joinWorkspace(owner, late);
        late = scoped(late, workspaceId);
        UUID chatId = createPrivateChannel(owner, "join", member.user().id());

        // CLOSED: a new participant cannot join through an invite link, even though the
        // token itself is valid; the existing member is unaffected.
        patchChat(owner, chatId, Map.of("join_policy", "CLOSED")).andExpect(status().isOk());
        assertThat(chatColumn(chatId, "join_policy")).isEqualTo("CLOSED");
        String token = json(createInvite(owner, chatId, Map.of("role", "MEMBER"))
                .andExpect(status().isCreated()).andReturn()).get("token").asText();
        MvcResult closed = mockMvc.perform(authed(post(
                        "/api/v1/invites/{token}/accept", token), late))
                .andExpect(status().isForbidden()).andReturn();
        assertThat(json(closed).get("code").asText()).isEqualTo("CHAT_JOIN_CLOSED");
        assertThat(chatMemberRole(chatId, late.user().id())).isNull();

        // INVITE_ONLY: the same link now joins with the invited role.
        patchChat(owner, chatId, Map.of("join_policy", "INVITE_ONLY"))
                .andExpect(status().isOk());
        MvcResult joined = mockMvc.perform(authed(post(
                        "/api/v1/invites/{token}/accept", token), late))
                .andExpect(status().isOk()).andReturn();
        assertThat(json(joined).get("already_member").asBoolean()).isFalse();
        assertThat(chatMemberRole(chatId, late.user().id())).isEqualTo("MEMBER");

        // Switching PRIVATE -> PUBLIC makes the channel workspace-wide: an ACTIVE workspace
        // member who was not selected joins immediately and the join policy becomes OPEN.
        joinWorkspace(owner, late2);
        assertThat(chatMemberRole(chatId, late2.user().id())).isNull();
        MvcResult publicSwitch = patchChat(owner, chatId, Map.of("visibility", "PUBLIC"))
                .andExpect(status().isOk()).andReturn();
        assertThat(json(publicSwitch).get("visibility").asText()).isEqualTo("PUBLIC");
        assertThat(json(publicSwitch).get("join_policy").asText()).isEqualTo("OPEN");
        assertThat(chatMemberRole(chatId, late2.user().id())).isEqualTo("MEMBER");
        assertThat(visibilityRow(chatId)).isEqualTo("PUBLIC");
        assertThat(chatColumn(chatId, "join_policy")).isEqualTo("OPEN");
    }

    @Test
    void schemaRlsAndForeignKeysBackTheNewSettings() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("p02-schema-owner"));
        SessionResponse outsider = devSession(uniqueDisplayName("p02-schema-outsider"));
        UUID workspaceId = owner.workspace().id();
        UUID chatId = owner.chat().id();
        joinWorkspace(owner, outsider);

        assertThat(columnExists("chat", "chats", "cover_file_id")).isTrue();
        assertThat(columnExists("chat", "chats", "join_policy")).isTrue();
        assertThat(columnExists("chat", "chats", "read_only")).isTrue();
        assertThat(columnExists("chat", "chat_pins", "message_id")).isTrue();
        assertThat(columnExists("chat", "user_chat_archive", "archived_at")).isTrue();

        for (String table : List.of("chat_permissions", "user_chat_archive", "chat_pins")) {
            assertThat(migrator().queryForObject("""
                    SELECT relrowsecurity AND relforcerowsecurity
                      FROM pg_class WHERE oid = ('chat.' || ?)::regclass
                    """, Boolean.class, table)).as(table).isTrue();
            assertThat(migrator().queryForObject("""
                    SELECT has_table_privilege('krug_app', ('chat.' || ?)::regclass, 'SELECT')
                    """, Boolean.class, table)).as(table).isTrue();
        }
        assertThat(migrator().queryForObject("""
                SELECT has_table_privilege('krug_app', 'chat.chat_pins', 'INSERT')
                   AND has_table_privilege('krug_app', 'chat.chat_pins', 'DELETE')
                   AND has_table_privilege('krug_app', 'chat.user_chat_archive', 'INSERT')
                   AND has_table_privilege('krug_app', 'chat.user_chat_archive', 'DELETE')
                   AND has_table_privilege('krug_app', 'chat.chat_permissions', 'UPDATE')
                """, Boolean.class)).isTrue();

        // Defaults: every GROUP channel has 30 effective rows; a DIRECT chat has none.
        assertThat(permissionRowCount(chatId)).isEqualTo(30);
        UUID directId = createDirect(owner, outsider.user().id());
        assertThat(permissionRowCount(directId)).isZero();
        assertThat(migrator().queryForObject("""
                SELECT allowed FROM chat.chat_permissions
                 WHERE chat_id = ? AND role = 'MEMBER' AND permission = 'pin_messages'
                """, Boolean.class, chatId)).isFalse();

        // Pin rows carry metadata only.
        assertThat(migrator().queryForList("""
                SELECT column_name FROM information_schema.columns
                 WHERE table_schema = 'chat' AND table_name = 'chat_pins'
                """, String.class)).containsExactlyInAnyOrder(
                "chat_id", "message_id", "workspace_id", "pinned_by", "pinned_at");

        // The cover FK rejects a dangling attachment id even with a superuser connection.
        assertThatThrownBy(() -> migrator().update(
                "UPDATE chat.chats SET cover_file_id = ? WHERE id = ?",
                UUID.randomUUID(), chatId)).isInstanceOf(DataAccessException.class);
        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM pg_constraint WHERE conname = 'fk_chats_cover_file'
                """, Long.class)).isEqualTo(1L);

        // Cross-tenant invisibility for the two per-user tables.
        mockMvc.perform(authed(archive(chatId), owner)).andExpect(status().isNoContent());
        Long visibleArchive = inTenant(outsider.user().id(), outsider.workspace().id(), () ->
                jdbc.queryForObject("""
                        SELECT count(*) FROM chat.user_chat_archive WHERE chat_id = ?
                        """, Long.class, chatId));
        assertThat(visibleArchive).isZero();

        UUID messageId = messageId(sendMessage(owner, chatId, UUID.randomUUID().toString(),
                UUID.randomUUID().toString(), "pin me"));
        postPin(owner, chatId, messageId).andExpect(status().isCreated());
        Long visiblePins = inTenant(outsider.user().id(), outsider.workspace().id(), () ->
                jdbc.queryForObject("""
                        SELECT count(*) FROM chat.chat_pins WHERE chat_id = ?
                        """, Long.class, chatId));
        assertThat(visiblePins).isZero();
        Long visiblePermissions = inTenant(outsider.user().id(), outsider.workspace().id(), () ->
                jdbc.queryForObject("""
                        SELECT count(*) FROM chat.chat_permissions WHERE chat_id = ?
                        """, Long.class, chatId));
        assertThat(visiblePermissions).isZero();
    }

    // ------------------------------------------------------------------
    // HTTP helpers
    // ------------------------------------------------------------------

    private ResultActions patchChat(SessionResponse session, UUID chatId,
                                    Map<String, Object> body) throws Exception {
        return mockMvc.perform(authed(patch("/api/v1/chats/{chatId}", chatId), session)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(body)));
    }

    private MockHttpServletRequestBuilder getPermissions(UUID chatId) {
        return get("/api/v1/chats/{chatId}/permissions", chatId);
    }

    private ResultActions patchPermissions(SessionResponse session, UUID chatId,
                                           Map<String, Object> body) throws Exception {
        return mockMvc.perform(authed(patch("/api/v1/chats/{chatId}/permissions", chatId),
                        session)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(body)));
    }

    private MockHttpServletRequestBuilder postCover(UUID chatId) {
        return post("/api/v1/chats/{chatId}/cover", chatId);
    }

    private ResultActions postCover(SessionResponse session, UUID chatId, UUID fileId)
            throws Exception {
        return mockMvc.perform(authed(postCover(chatId), session)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(Map.of("file_id", fileId.toString()))));
    }

    private MockHttpServletRequestBuilder deleteCover(UUID chatId) {
        return delete("/api/v1/chats/{chatId}/cover", chatId);
    }

    private MockHttpServletRequestBuilder archive(UUID chatId) {
        return post("/api/v1/chats/{chatId}/archive", chatId);
    }

    private MockHttpServletRequestBuilder unarchive(UUID chatId) {
        return post("/api/v1/chats/{chatId}/unarchive", chatId);
    }

    private MockHttpServletRequestBuilder deleteChat(UUID chatId) {
        return delete("/api/v1/chats/{chatId}", chatId);
    }

    private MockHttpServletRequestBuilder getPins(UUID chatId) {
        return get("/api/v1/chats/{chatId}/pins", chatId);
    }

    private MockHttpServletRequestBuilder postPins(UUID chatId) {
        return post("/api/v1/chats/{chatId}/pins", chatId);
    }

    private ResultActions postPin(SessionResponse session, UUID chatId, UUID messageId)
            throws Exception {
        return mockMvc.perform(authed(postPins(chatId), session)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(
                        Map.of("message_id", messageId.toString()))));
    }

    private MockHttpServletRequestBuilder deletePin(UUID chatId, UUID messageId) {
        return delete("/api/v1/chats/{chatId}/pins/{messageId}", chatId, messageId);
    }

    private ResultActions send(SessionResponse session, UUID chatId, String text)
            throws Exception {
        return mockMvc.perform(sendWithKeys(session, chatId, UUID.randomUUID().toString(),
                UUID.randomUUID().toString(), text));
    }

    private MockHttpServletRequestBuilder sendWithKeys(SessionResponse session, UUID chatId,
                                                       String idempotencyKey,
                                                       String clientMessageId, String text)
            throws Exception {
        return authed(post("/api/v1/chats/{chatId}/messages", chatId), session)
                .header("Idempotency-Key", idempotencyKey)
                .contentType(MediaType.APPLICATION_JSON)
                .content(messageBody(clientMessageId, text, null));
    }

    private MockHttpServletRequestBuilder patchPlugin(UUID chatId, String pluginId) {
        return patch("/api/v1/chats/{chatId}/plugins/{pluginId}", chatId, pluginId);
    }

    private ResultActions postPoll(SessionResponse session, UUID chatId) throws Exception {
        return mockMvc.perform(authed(post("/api/v1/chats/{chatId}/polls", chatId), session)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(Map.of(
                        "question", "Lunch?",
                        "options", List.of("Pizza", "Sushi")))));
    }

    private MockHttpServletRequestBuilder postInvite(UUID chatId) {
        return post("/api/v1/chats/{chatId}/invites", chatId);
    }

    private ResultActions createInvite(SessionResponse session, UUID chatId,
                                       Map<String, Object> body) throws Exception {
        return mockMvc.perform(authed(postInvite(chatId), session)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(body)));
    }

    private ResultActions addMember(SessionResponse session, UUID chatId, UUID userId,
                                    String role) throws Exception {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("user_id", userId.toString());
        if (role != null) {
            body.put("role", role);
        }
        return mockMvc.perform(authed(post("/api/v1/chats/{chatId}/members", chatId), session)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(body)));
    }

    private ResultActions changeRole(SessionResponse session, UUID chatId, UUID userId,
                                     String role) throws Exception {
        return mockMvc.perform(authed(patch(
                        "/api/v1/chats/{chatId}/members/{userId}", chatId, userId), session)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(Map.of("role", role))));
    }

    private SessionResponse scoped(SessionResponse user, UUID workspaceId) {
        IssuedToken token = tokenIssuer.issue(user.user().id(), user.device().id(), workspaceId);
        return new SessionResponse(token.accessToken(), token.expiresAt(), user.user(),
                user.device(), user.workspace(), user.chat());
    }

    private void joinWorkspace(SessionResponse owner, SessionResponse user) throws Exception {
        addWorkspaceMember(owner, owner.workspace().id(), user.user().id(), "MEMBER");
    }

    private void addWorkspaceMember(SessionResponse owner, UUID workspaceId, UUID userId,
                                    String role) throws Exception {
        mockMvc.perform(authed(post("/api/v1/workspaces/{workspaceId}/members", workspaceId),
                        owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "email", emailOf(userId), "role", role))))
                .andExpect(status().isCreated());
    }

    private UUID createPrivateChannel(SessionResponse owner, String name, UUID... memberIds)
            throws Exception {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("type", "GROUP");
        body.put("name", "p02-" + name + "-" + UUID.randomUUID());
        body.put("visibility", "PRIVATE");
        body.put("member_ids", List.of(memberIds));
        MvcResult result = mockMvc.perform(authed(post(
                                "/api/v1/workspaces/{workspaceId}/chats",
                                owner.workspace().id()), owner)
                        .header("Idempotency-Key", UUID.randomUUID().toString())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(body)))
                .andExpect(status().isCreated())
                .andReturn();
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
                .andExpect(status().isCreated())
                .andReturn();
        return UUID.fromString(json(result).get("id").asText());
    }

    private MvcResult chatListRaw(SessionResponse session, UUID workspaceId,
                                  boolean archived) throws Exception {
        return mockMvc.perform(authed(get("/api/v1/workspaces/{workspaceId}/chats",
                        workspaceId), session)
                        .param("archived", Boolean.toString(archived)))
                .andExpect(status().isOk())
                .andReturn();
    }

    private JsonNode itemInList(JsonNode list, UUID chatId) {
        for (JsonNode item : list.get("items")) {
            if (item.get("id").asText().equals(chatId.toString())) {
                return item;
            }
        }
        return null;
    }

    // ------------------------------------------------------------------
    // DB helpers
    // ------------------------------------------------------------------

    private UUID messageId(JsonNode message) {
        return UUID.fromString(message.get("id").asText());
    }

    private UUID coverFileId(UUID chatId) {
        return migrator().queryForObject(
                "SELECT cover_file_id FROM chat.chats WHERE id = ?", UUID.class, chatId);
    }

    private java.time.Instant deletedAt(UUID chatId) {
        return migrator().queryForObject(
                "SELECT deleted_at FROM chat.chats WHERE id = ?",
                java.time.Instant.class, chatId);
    }

    private Object chatColumn(UUID chatId, String column) {
        return migrator().queryForObject(
                "SELECT " + column + " FROM chat.chats WHERE id = ?", Object.class, chatId);
    }

    private String chatMemberRole(UUID chatId, UUID userId) {
        List<String> rows = migrator().queryForList("""
                SELECT role FROM chat.chat_members
                 WHERE chat_id = ? AND user_id = ? AND status = 'ACTIVE'
                """, String.class, chatId, userId);
        return rows.isEmpty() ? null : rows.get(0);
    }

    private String visibilityRow(UUID chatId) {
        List<String> rows = migrator().queryForList("""
                SELECT visibility FROM chat.channel_settings WHERE chat_id = ?
                """, String.class, chatId);
        return rows.isEmpty() ? null : rows.get(0);
    }

    private long permissionRowCount(UUID chatId) {
        return migrator().queryForObject("""
                SELECT count(*) FROM chat.chat_permissions WHERE chat_id = ?
                """, Long.class, chatId);
    }

    private long pinCount(UUID chatId) {
        return migrator().queryForObject("""
                SELECT count(*) FROM chat.chat_pins WHERE chat_id = ?
                """, Long.class, chatId);
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

    private void assertAllTrue(JsonNode role) {
        assertThat(role.get("post_messages").asBoolean()).isTrue();
        assertThat(role.get("invite_members").asBoolean()).isTrue();
        assertThat(role.get("create_polls").asBoolean()).isTrue();
        assertThat(role.get("start_calls").asBoolean()).isTrue();
        assertThat(role.get("pin_messages").asBoolean()).isTrue();
        assertThat(role.get("change_info").asBoolean()).isTrue();
    }

    private void assertForbidden(ResultActions actions) throws Exception {
        MvcResult result = actions.andExpect(status().isForbidden()).andReturn();
        CONTRACT.assertValid("Error", json(result));
    }

    private void assertValidationError(ResultActions actions, String expectedKey)
            throws Exception {
        MvcResult result = actions.andExpect(status().isUnprocessableEntity()).andReturn();
        JsonNode body = json(result);
        assertThat(body.get("code").asText()).isEqualTo("VALIDATION_FAILED");
        String details = body.get("details").toString();
        assertThat(details).contains(expectedKey);
    }
}
