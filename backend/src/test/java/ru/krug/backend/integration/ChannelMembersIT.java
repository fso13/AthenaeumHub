package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

import ru.krug.backend.chat.domain.service.InviteTokens;
import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.support.IntegrationTestBase;
import ru.krug.backend.support.OpenApiContract;

/**
 * P0-1 (#79): channel member management, invite links and user blocks.
 *
 * <p>Covers the member list with display details plus the legacy {@code user_ids}
 * projection, add/role/remove/leave with the OWNER/ADMIN ceiling and last-OWNER protection,
 * DIRECT rejection, idempotency, invite create/list/accept/revoke/expiry/max-uses, the
 * one-time raw token (hash only in the DB), block idempotency and self-scoping, audit
 * minimisation, RLS/grants and the untouched chat limits.</p>
 */
@ActiveProfiles("test")
class ChannelMembersIT extends IntegrationTestBase {

    private static final OpenApiContract CONTRACT = OpenApiContract.load();

    @AfterEach
    void restoreChatLimits() {
        migrator().update("""
                UPDATE ops.system_settings
                   SET max_chats_per_user = 100, max_chats_per_workspace = 1000
                 WHERE id = 1
                """);
    }

    @Test
    void memberListExposesDetailsAndLegacyIdsWithoutEmail() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("members-owner"));
        SessionResponse member = devSession(uniqueDisplayName("members-member"));
        SessionResponse outsider = devSession(uniqueDisplayName("members-outsider"));
        joinWorkspace(owner, member);

        MvcResult result = mockMvc.perform(authed(getMembers(owner.chat().id()), owner))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode body = json(result);
        CONTRACT.assertValid("ChatMemberIds", body);

        assertThat(body.get("members")).hasSize(2);
        Set<String> ids = new LinkedHashSet<>();
        Set<String> names = new LinkedHashSet<>();
        for (JsonNode item : body.get("members")) {
            CONTRACT.assertValid("ChatMember", item);
            ids.add(item.get("user_id").asText());
            names.add(item.get("display_name").asText());
            assertThat(item.get("status").asText()).isEqualTo("ACTIVE");
            assertThat(item.get("joined_at").asText()).isNotBlank();
            assertThat(item.get("display_name").asText()).isNotBlank();
        }
        assertThat(ids).containsExactlyInAnyOrder(owner.user().id().toString(),
                member.user().id().toString());
        assertThat(names).allSatisfy(name -> assertThat(name).isNotBlank());

        List<String> userIds = new ArrayList<>();
        body.get("user_ids").forEach(node -> userIds.add(node.asText()));
        assertThat(userIds).containsExactlyInAnyOrderElementsOf(ids);
        assertThat(result.getResponse().getContentAsString())
                .doesNotContain("\"email\"")
                .doesNotContain("\"devices\"");

        // A participant can read the list too.
        mockMvc.perform(authed(getMembers(owner.chat().id()), member))
                .andExpect(status().isOk());

        // A non-member cannot learn that the chat exists.
        MvcResult denied = mockMvc.perform(authed(getMembers(owner.chat().id()), outsider))
                .andExpect(status().isNotFound())
                .andReturn();
        CONTRACT.assertValid("Error", json(denied));

        // DIRECT chats keep a sensible read-only member view.
        UUID directId = createDirect(owner, member.user().id());
        MvcResult direct = mockMvc.perform(authed(getMembers(directId), owner))
                .andExpect(status().isOk())
                .andReturn();
        CONTRACT.assertValid("ChatMemberIds", json(direct));
        assertThat(json(direct).get("members")).hasSize(2);
    }

    @Test
    void addMemberChangeRoleAndPermissionCeilings() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("members-add-owner"));
        SessionResponse member1 = devSession(uniqueDisplayName("members-add-one"));
        SessionResponse member2 = devSession(uniqueDisplayName("members-add-two"));
        SessionResponse admin = devSession(uniqueDisplayName("members-add-admin"));
        SessionResponse bystander = devSession(uniqueDisplayName("members-add-bystander"));
        SessionResponse lateMember = devSession(uniqueDisplayName("members-add-late"));
        SessionResponse outsider = devSession(uniqueDisplayName("members-add-outsider"));
        joinWorkspace(owner, member1);
        joinWorkspace(owner, member2);
        joinWorkspace(owner, admin);
        joinWorkspace(owner, bystander);

        UUID chatId = createPrivateChannel(owner, "add", member1.user().id(),
                admin.user().id());

        // Add with an explicit role: 201 + ChatMember.
        MvcResult added = addMember(owner, chatId, member2.user().id(), "MODERATOR")
                .andExpect(status().isCreated())
                .andReturn();
        JsonNode addedBody = json(added);
        CONTRACT.assertValid("ChatMember", addedBody);
        assertThat(addedBody.get("user_id").asText()).isEqualTo(member2.user().id().toString());
        assertThat(addedBody.get("role").asText()).isEqualTo("MODERATOR");
        assertThat(chatMember(chatId, member2.user().id()).get("status")).isEqualTo("ACTIVE");

        // Idempotent repeat: 200, current role unchanged, no second audit event.
        MvcResult replay = addMember(owner, chatId, member2.user().id(), null)
                .andExpect(status().isOk())
                .andReturn();
        assertThat(json(replay).get("role").asText()).isEqualTo("MODERATOR");
        assertThat(auditCount("chat.member.added", chatId)).isEqualTo(1L);

        // Same-role PATCH is idempotent and does not add another role_changed event.
        changeRole(owner, chatId, member2.user().id(), "MODERATOR").andExpect(status().isOk());
        assertThat(auditCount("chat.member.role_changed", chatId)).isZero();

        MvcResult changed = changeRole(owner, chatId, member2.user().id(), "MEMBER")
                .andExpect(status().isOk())
                .andReturn();
        CONTRACT.assertValid("ChatMember", json(changed));
        assertThat(json(changed).get("role").asText()).isEqualTo("MEMBER");
        Map<String, Object> roleEvent = auditEvent("chat.member.role_changed", chatId);
        assertThat(roleEvent.get("actor_id")).isEqualTo(owner.user().id());
        assertThat(String.valueOf(roleEvent.get("metadata")))
                .contains(member2.user().id().toString())
                .contains("previous_role", "MODERATOR")
                .doesNotContain("@example.test")
                .doesNotContain(displayNameOf(member2.user().id()));

        // ADMIN ceiling: cannot assign ADMIN, cannot manage an OWNER.
        changeRole(owner, chatId, admin.user().id(), "ADMIN").andExpect(status().isOk());
        MvcResult roleCeiling = addMember(admin, chatId, bystander.user().id(), "ADMIN")
                .andExpect(status().isForbidden())
                .andReturn();
        assertThat(json(roleCeiling).get("code").asText()).isEqualTo("ROLE_CHANGE_FORBIDDEN");

        // A workspace member who is not in the chat cannot manage it.
        MvcResult notParticipant = addMember(bystander, chatId, member2.user().id(), "MEMBER")
                .andExpect(status().isForbidden())
                .andReturn();
        CONTRACT.assertValid("Error", json(notParticipant));
        addMember(admin, chatId, bystander.user().id(), "GUEST").andExpect(status().isCreated());
        MvcResult ownerManagedByAdmin = changeRole(admin, chatId, owner.user().id(), "MEMBER")
                .andExpect(status().isForbidden())
                .andReturn();
        assertThat(json(ownerManagedByAdmin).get("code").asText())
                .isEqualTo("ROLE_CHANGE_FORBIDDEN");

        // Self-add and non-workspace targets are rejected.
        MvcResult self = addMember(owner, chatId, owner.user().id(), "MEMBER")
                .andExpect(status().isConflict())
                .andReturn();
        assertThat(json(self).get("code").asText()).isEqualTo("SELF_ACTION_FORBIDDEN");
        MvcResult unknown = addMember(owner, chatId, outsider.user().id(), "MEMBER")
                .andExpect(status().isNotFound())
                .andReturn();
        assertThat(json(unknown).get("code").asText()).isEqualTo("USER_NOT_FOUND");

        // Invalid role literal and DIRECT chats.
        MvcResult badRole = addMember(owner, chatId, member2.user().id(), "SUPERUSER")
                .andExpect(status().isBadRequest())
                .andReturn();
        assertThat(json(badRole).get("code").asText()).isEqualTo("VALIDATION_FAILED");
        UUID directId = createDirect(owner, member1.user().id());
        MvcResult directAdd = addMember(owner, directId, member2.user().id(), "MEMBER")
                .andExpect(status().isUnprocessableEntity())
                .andReturn();
        assertThat(json(directAdd).get("code").asText()).isEqualTo("CHAT_MEMBERSHIP_UNSUPPORTED");

        // Adding a member never consumes a chat-limit slot (limits are at their current
        // usage and a genuinely new participant still joins).
        joinWorkspace(owner, lateMember);
        setChatLimits(chatsUsedByUser(owner), chatsInWorkspace(owner));
        addMember(owner, chatId, lateMember.user().id(), "MEMBER")
                .andExpect(status().isCreated());
    }

    @Test
    void removeAndLeavePreserveTheLastOwnerAndAreIdempotent() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("members-remove-owner"));
        SessionResponse admin = devSession(uniqueDisplayName("members-remove-admin"));
        SessionResponse member = devSession(uniqueDisplayName("members-remove-member"));
        joinWorkspace(owner, admin);
        joinWorkspace(owner, member);

        UUID chatId = createPrivateChannel(owner, "remove", admin.user().id(),
                member.user().id());
        changeRole(owner, chatId, admin.user().id(), "ADMIN").andExpect(status().isOk());

        // An ADMIN removes a MEMBER; a repeat removal is 404 (only leave is idempotent).
        mockMvc.perform(authed(deleteMember(chatId, member.user().id()), admin))
                .andExpect(status().isNoContent());
        assertThat(chatMember(chatId, member.user().id()).get("status")).isEqualTo("REMOVED");
        MvcResult repeat = mockMvc.perform(authed(deleteMember(chatId, member.user().id()), admin))
                .andExpect(status().isNotFound())
                .andReturn();
        assertThat(json(repeat).get("code").asText()).isEqualTo("MEMBER_NOT_FOUND");

        // An ADMIN cannot remove an OWNER.
        MvcResult adminRemoveOwner = mockMvc.perform(authed(
                        deleteMember(chatId, owner.user().id()), admin))
                .andExpect(status().isForbidden())
                .andReturn();
        assertThat(json(adminRemoveOwner).get("code").asText())
                .isEqualTo("ROLE_CHANGE_FORBIDDEN");

        // The removed member loses access to the member list.
        mockMvc.perform(authed(getMembers(chatId), member))
                .andExpect(status().isNotFound());

        // The last OWNER cannot leave (POST alias, DELETE self and DELETE endpoint).
        assertThat(mockMvc.perform(authed(post("/api/v1/chats/{chatId}/leave", chatId), owner))
                .andExpect(status().isConflict())
                .andReturn().getResponse().getContentAsString()).contains("LAST_OWNER");
        assertThat(mockMvc.perform(authed(deleteMember(chatId, owner.user().id()), owner))
                .andExpect(status().isConflict())
                .andReturn().getResponse().getContentAsString()).contains("LAST_OWNER");

        // Promote the ADMIN to OWNER: now the first owner may leave, twice (idempotent).
        changeRole(owner, chatId, admin.user().id(), "OWNER").andExpect(status().isOk());
        mockMvc.perform(authed(post("/api/v1/chats/{chatId}/leave", chatId), owner))
                .andExpect(status().isNoContent());
        mockMvc.perform(authed(post("/api/v1/chats/{chatId}/leave", chatId), owner))
                .andExpect(status().isNoContent());
        mockMvc.perform(authed(deleteMember(chatId, owner.user().id()), owner))
                .andExpect(status().isNoContent());
        assertThat(chatMember(chatId, owner.user().id()).get("status")).isEqualTo("REMOVED");
        assertThat(auditCount("chat.member.left", chatId)).isEqualTo(1L);

        // The remaining OWNER is the last one and cannot leave.
        mockMvc.perform(authed(post("/api/v1/chats/{chatId}/leave", chatId), admin))
                .andExpect(status().isConflict());

        // A REMOVED member can be re-added; the role is applied again.
        MvcResult reAdded = addMember(admin, chatId, member.user().id(), "MEMBER")
                .andExpect(status().isCreated())
                .andReturn();
        assertThat(json(reAdded).get("status").asText()).isEqualTo("ACTIVE");
        assertThat(auditCount("chat.member.removed", chatId)).isEqualTo(1L);

        // DIRECT leave is unsupported (the pair is fixed).
        UUID directId = createDirect(owner, member.user().id());
        MvcResult directLeave = mockMvc.perform(authed(
                        post("/api/v1/chats/{chatId}/leave", directId), owner))
                .andExpect(status().isUnprocessableEntity())
                .andReturn();
        assertThat(json(directLeave).get("code").asText())
                .isEqualTo("CHAT_MEMBERSHIP_UNSUPPORTED");
    }

    @Test
    void invitesAreHashedOneTimeAndSupportAcceptExpiryUsesAndRevocation() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("invites-owner"));
        SessionResponse memberA = devSession(uniqueDisplayName("invites-a"));
        SessionResponse memberB = devSession(uniqueDisplayName("invites-b"));
        SessionResponse memberC = devSession(uniqueDisplayName("invites-c"));
        SessionResponse memberD = devSession(uniqueDisplayName("invites-d"));
        SessionResponse memberE = devSession(uniqueDisplayName("invites-e"));
        SessionResponse outsider = devSession(uniqueDisplayName("invites-outsider"));
        for (SessionResponse user : List.of(memberA, memberB, memberC, memberD, memberE)) {
            joinWorkspace(owner, user);
        }

        UUID chatId = createPrivateChannel(owner, "invites", memberA.user().id());

        MvcResult created = createInvite(owner, chatId,
                Map.of("role", "MEMBER", "max_uses", 1, "expires_in_seconds", 3600))
                .andExpect(status().isCreated())
                .andReturn();
        JsonNode createdBody = json(created);
        CONTRACT.assertValid("ChatInviteCreated", createdBody);
        String token = createdBody.get("token").asText();
        assertThat(token).matches("^[A-Za-z0-9_-]{20,128}$");
        assertThat(createdBody.get("status").asText()).isEqualTo("ACTIVE");
        UUID inviteId = UUID.fromString(createdBody.get("id").asText());

        // Only the SHA-256 hash is persisted; the raw token never reaches the database.
        assertThat(inviteTokenHash(inviteId)).isEqualTo(InviteTokens.hash(token));
        assertThat(inviteTokenHash(inviteId)).isNotEqualTo(token);
        assertThat(columnExists("chat", "invites", "token")).isFalse();
        assertThat(columnExists("chat", "invites", "token_hash")).isTrue();

        // List is metadata-only.
        MvcResult listed = mockMvc.perform(authed(getInvites(chatId), owner))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode list = json(listed);
        CONTRACT.assertValid("ChatInviteList", list);
        assertThat(list.get("items")).hasSize(1);
        assertThat(list.get("items").get(0).get("token")).isNull();
        assertThat(listed.getResponse().getContentAsString()).doesNotContain(token);
        assertThat(listed.getResponse().getContentAsString()).doesNotContain("token_hash");
        assertThat(list.get("items").get(0).get("used_count").asInt()).isZero();

        // An existing member of the channel gets the idempotent answer, no use is consumed.
        MvcResult already = accept(memberA, token).andExpect(status().isOk()).andReturn();
        JsonNode alreadyBody = json(already);
        CONTRACT.assertValid("InviteAcceptResult", alreadyBody);
        assertThat(alreadyBody.get("already_member").asBoolean()).isTrue();
        assertThat(alreadyBody.get("role").asText()).isEqualTo("MEMBER");
        assertThat(inviteUsedCount(inviteId)).isZero();

        // A non-member joins with the invite role and consumes exactly one use.
        MvcResult joined = accept(memberB, token).andExpect(status().isOk()).andReturn();
        assertThat(json(joined).get("already_member").asBoolean()).isFalse();
        assertThat(chatMember(chatId, memberB.user().id()).get("role")).isEqualTo("MEMBER");
        assertThat(inviteUsedCount(inviteId)).isEqualTo(1);
        MvcResult replay = accept(memberB, token).andExpect(status().isOk()).andReturn();
        assertThat(json(replay).get("already_member").asBoolean()).isTrue();
        assertThat(inviteUsedCount(inviteId)).isEqualTo(1);
        assertThat(auditCount("chat.invite.accepted", chatId)).isEqualTo(1L);

        // max_uses exhausted for another workspace member.
        MvcResult exhausted = accept(memberC, token).andExpect(status().isGone()).andReturn();
        assertThat(json(exhausted).get("code").asText()).isEqualTo("INVITE_EXHAUSTED");

        // Expired link: mint a fresh link and move its expiry into the past in the database
        // (the raw token is only ever available at creation time).
        String expiredToken = json(createInvite(owner, chatId, Map.of("role", "MEMBER"))
                .andExpect(status().isCreated()).andReturn()).get("token").asText();
        UUID expiredId = inviteIdByHash(InviteTokens.hash(expiredToken));
        migrator().update("""
                UPDATE chat.invites SET expires_at = now() - interval '1 second' WHERE id = ?
                """, expiredId);
        MvcResult expired = accept(memberC, expiredToken).andExpect(status().isGone()).andReturn();
        assertThat(json(expired).get("code").asText()).isEqualTo("INVITE_EXPIRED");
        assertThat(inviteDbStatus(expiredId)).isEqualTo("EXPIRED");

        // Revocation is idempotent and the link answers 410 INVITE_REVOKED.
        String revokedToken = json(createInvite(owner, chatId, Map.of("role", "MEMBER"))
                .andExpect(status().isCreated()).andReturn()).get("token").asText();
        UUID revokedId = inviteIdByHash(InviteTokens.hash(revokedToken));
        mockMvc.perform(authed(deleteInvite(chatId, revokedId), owner))
                .andExpect(status().isNoContent());
        mockMvc.perform(authed(deleteInvite(chatId, revokedId), owner))
                .andExpect(status().isNoContent());
        assertThat(auditCount("chat.invite.revoked", chatId)).isEqualTo(1L);
        MvcResult revoked = accept(memberE, revokedToken)
                .andExpect(status().isGone()).andReturn();
        assertThat(json(revoked).get("code").asText()).isEqualTo("INVITE_REVOKED");

        // Unknown token, non-workspace caller and non-manager access.
        MvcResult unknown = accept(memberD, InviteTokens.newToken())
                .andExpect(status().isNotFound()).andReturn();
        assertThat(json(unknown).get("code").asText()).isEqualTo("INVITE_NOT_FOUND");
        MvcResult foreign = accept(outsider, revokedToken)
                .andExpect(status().isForbidden()).andReturn();
        CONTRACT.assertValid("Error", json(foreign));
        mockMvc.perform(authed(getInvites(chatId), memberB)).andExpect(status().isForbidden());
        mockMvc.perform(authed(postInvite(chatId), memberB)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{}"))
                .andExpect(status().isForbidden());

        // Validation and DIRECT rejection.
        MvcResult ownerRole = createInvite(owner, chatId, Map.of("role", "OWNER"))
                .andExpect(status().isBadRequest()).andReturn();
        assertThat(json(ownerRole).get("code").asText()).isEqualTo("VALIDATION_FAILED");
        createInvite(owner, chatId, Map.of("max_uses", 0))
                .andExpect(status().isBadRequest());
        UUID directId = createDirect(owner, memberA.user().id());
        MvcResult directInvite = createInvite(owner, directId, Map.of())
                .andExpect(status().isUnprocessableEntity()).andReturn();
        assertThat(json(directInvite).get("code").asText())
                .isEqualTo("CHAT_MEMBERSHIP_UNSUPPORTED");

        // Audit is metadata-only: no token, no hash, no email/display name.
        Map<String, Object> createdEvent = auditEvent("chat.invite.created", chatId);
        JsonNode metadata = objectMapper.readTree(String.valueOf(createdEvent.get("metadata")));
        assertThat(metadata.fieldNames()).toIterable()
                .containsExactlyInAnyOrder("invite_id", "role", "max_uses", "expires_at");
        assertThat(String.valueOf(createdEvent.get("metadata")))
                .doesNotContain(token)
                .doesNotContain(InviteTokens.hash(token))
                .doesNotContain("@example.test");
        Map<String, Object> acceptedEvent = auditEvent("chat.invite.accepted", chatId);
        JsonNode acceptedMetadata = objectMapper.readTree(
                String.valueOf(acceptedEvent.get("metadata")));
        assertThat(acceptedMetadata.fieldNames()).toIterable()
                .containsExactlyInAnyOrder("invite_id", "user_id", "role");
        assertThat(String.valueOf(acceptedEvent.get("metadata")))
                .doesNotContain(displayNameOf(memberB.user().id()));
    }

    @Test
    void blocksAreIdempotentSelfScopedAndAuditOnce() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("blocks-owner"));
        SessionResponse target = devSession(uniqueDisplayName("blocks-target"));

        mockMvc.perform(authed(block(target.user().id()), owner))
                .andExpect(status().isNoContent());
        mockMvc.perform(authed(block(target.user().id()), owner))
                .andExpect(status().isNoContent());
        assertThat(blockCount(owner.user().id(), target.user().id())).isEqualTo(1L);
        assertThat(auditCount("user.blocked", target.user().id())).isEqualTo(1L);

        MvcResult listed = mockMvc.perform(authed(get("/api/v1/me/blocked"), owner))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode body = json(listed);
        CONTRACT.assertValid("BlockedUserList", body);
        assertThat(body.get("items")).hasSize(1);
        CONTRACT.assertValid("BlockedUser", body.get("items").get(0));
        assertThat(body.get("items").get(0).get("user_id").asText())
                .isEqualTo(target.user().id().toString());
        assertThat(body.get("items").get(0).get("blocked_at").asText()).isNotBlank();
        assertThat(listed.getResponse().getContentAsString())
                .doesNotContain("email")
                .doesNotContain("display_name");

        // Another user cannot see someone else's block list.
        MvcResult others = mockMvc.perform(authed(get("/api/v1/me/blocked"), target))
                .andExpect(status().isOk())
                .andReturn();
        assertThat(json(others).get("items")).isEmpty();

        mockMvc.perform(authed(unblock(target.user().id()), owner))
                .andExpect(status().isNoContent());
        mockMvc.perform(authed(unblock(target.user().id()), owner))
                .andExpect(status().isNoContent());
        assertThat(blockCount(owner.user().id(), target.user().id())).isZero();
        assertThat(auditCount("user.unblocked", target.user().id())).isEqualTo(1L);
        assertThat(json(mockMvc.perform(authed(get("/api/v1/me/blocked"), owner))
                .andExpect(status().isOk()).andReturn()).get("items")).isEmpty();

        MvcResult self = mockMvc.perform(authed(block(owner.user().id()), owner))
                .andExpect(status().isBadRequest()).andReturn();
        assertThat(json(self).get("code").asText()).isEqualTo("VALIDATION_FAILED");
        MvcResult unknown = mockMvc.perform(authed(block(UUID.randomUUID()), owner))
                .andExpect(status().isNotFound()).andReturn();
        assertThat(json(unknown).get("code").asText()).isEqualTo("USER_NOT_FOUND");
    }

    @Test
    void schemaRlsAndGrantsBackstopTheNewTables() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("members-schema-owner"));
        SessionResponse member = devSession(uniqueDisplayName("members-schema-member"));
        SessionResponse outsider = devSession(uniqueDisplayName("members-schema-outsider"));
        joinWorkspace(owner, member);
        UUID chatId = createPrivateChannel(owner, "schema", member.user().id());

        for (String table : List.of("chat.invites", "auth.user_blocks")) {
            Map<String, Object> flags = migrator().queryForMap("""
                    SELECT relrowsecurity, relforcerowsecurity
                      FROM pg_class WHERE oid = ?::regclass
                    """, table);
            assertThat(flags.get("relrowsecurity")).as(table).isEqualTo(true);
            assertThat(flags.get("relforcerowsecurity")).as(table).isEqualTo(true);
        }
        assertThat(migrator().queryForObject("""
                SELECT has_table_privilege('krug_app', 'chat.invites', 'SELECT')
                   AND has_table_privilege('krug_app', 'chat.invites', 'INSERT')
                   AND has_table_privilege('krug_app', 'chat.invites', 'UPDATE')
                   AND has_table_privilege('krug_app', 'chat.invites', 'DELETE')
                """, Boolean.class)).isTrue();
        assertThat(migrator().queryForObject("""
                SELECT has_table_privilege('krug_app', 'auth.user_blocks', 'SELECT')
                   AND has_table_privilege('krug_app', 'auth.user_blocks', 'INSERT')
                   AND has_table_privilege('krug_app', 'auth.user_blocks', 'DELETE')
                """, Boolean.class)).isTrue();
        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM pg_indexes
                 WHERE schemaname = 'chat' AND indexname = 'ix_invites_chat_created'
                """, Long.class)).isEqualTo(1L);
        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM pg_indexes
                 WHERE schemaname = 'auth' AND indexname = 'ix_user_blocks_blocker_created'
                """, Long.class)).isEqualTo(1L);
        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM pg_proc p
                  JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname IN ('chat', 'auth')
                   AND p.proname IN ('member_directory', 'accept_invite', 'set_user_block')
                   AND has_function_privilege('public', p.oid, 'EXECUTE')
                """, Long.class)).isZero();

        createInvite(owner, chatId, Map.of("role", "MEMBER"));
        Long visible = inTenant(outsider.user().id(), outsider.workspace().id(), () ->
                jdbc.queryForObject("""
                        SELECT count(*) FROM chat.invites WHERE chat_id = ?
                        """, Long.class, chatId));
        assertThat(visible).isZero();
        Long blocksVisible = inTenant(outsider.user().id(), owner.workspace().id(), () ->
                jdbc.queryForObject("""
                        SELECT count(*) FROM auth.user_blocks WHERE blocker_id = ?
                        """, Long.class, owner.user().id()));
        assertThat(blocksVisible).isZero();
    }

    @Test
    void auditMetadataForMembershipChangesStaysIdOnly() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("members-audit-owner"));
        SessionResponse member = devSession(uniqueDisplayName("members-audit-member"));
        SessionResponse addedUser = devSession(uniqueDisplayName("members-audit-added"));
        joinWorkspace(owner, member);
        joinWorkspace(owner, addedUser);
        UUID chatId = createPrivateChannel(owner, "audit", member.user().id());

        addMember(owner, chatId, addedUser.user().id(), "MEMBER")
                .andExpect(status().isCreated());
        changeRole(owner, chatId, addedUser.user().id(), "MODERATOR")
                .andExpect(status().isOk());
        mockMvc.perform(authed(deleteMember(chatId, addedUser.user().id()), owner))
                .andExpect(status().isNoContent());

        Map<String, Object> added = auditEvent("chat.member.added", chatId);
        JsonNode addedMetadata = objectMapper.readTree(String.valueOf(added.get("metadata")));
        assertThat(addedMetadata.fieldNames()).toIterable()
                .containsExactlyInAnyOrder("user_id", "role");
        assertThat(String.valueOf(added.get("metadata")))
                .doesNotContain(displayNameOf(addedUser.user().id()))
                .doesNotContain("@example.test");

        Map<String, Object> roleChanged = auditEvent("chat.member.role_changed", chatId);
        JsonNode roleMetadata = objectMapper.readTree(
                String.valueOf(roleChanged.get("metadata")));
        assertThat(roleMetadata.fieldNames()).toIterable()
                .containsExactlyInAnyOrder("user_id", "previous_role", "role");
        assertThat(roleMetadata.get("previous_role").asText()).isEqualTo("MEMBER");
        assertThat(roleMetadata.get("role").asText()).isEqualTo("MODERATOR");

        Map<String, Object> removed = auditEvent("chat.member.removed", chatId);
        JsonNode removedMetadata = objectMapper.readTree(
                String.valueOf(removed.get("metadata")));
        assertThat(removedMetadata.fieldNames()).toIterable()
                .containsExactlyInAnyOrder("user_id", "role");
    }

    // ------------------------------------------------------------------

    private SessionResponse joinWorkspace(SessionResponse owner, SessionResponse user)
            throws Exception {
        mockMvc.perform(authed(post("/api/v1/workspaces/{workspaceId}/members",
                        owner.workspace().id()), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "email", emailOf(user.user().id()), "role", "MEMBER"))))
                .andExpect(status().isCreated());
        return user;
    }

    private UUID createPrivateChannel(SessionResponse owner, String name, UUID... memberIds)
            throws Exception {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("type", "GROUP");
        body.put("name", "p0-1-" + name + "-" + UUID.randomUUID());
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
        UUID chatId = UUID.fromString(json(result).get("id").asText());
        assertThat(visibility(chatId)).isEqualTo("PRIVATE");
        return chatId;
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

    private MockHttpServletRequestBuilder getMembers(UUID chatId) {
        return get("/api/v1/chats/{chatId}/members", chatId);
    }

    private ResultActions addMember(SessionResponse actor, UUID chatId, UUID userId, String role)
            throws Exception {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("user_id", userId.toString());
        if (role != null) {
            body.put("role", role);
        }
        return mockMvc.perform(authed(post("/api/v1/chats/{chatId}/members", chatId), actor)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(body)));
    }

    private ResultActions changeRole(SessionResponse actor, UUID chatId, UUID userId, String role)
            throws Exception {
        return mockMvc.perform(authed(patch(
                        "/api/v1/chats/{chatId}/members/{userId}", chatId, userId), actor)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(Map.of("role", role))));
    }

    private MockHttpServletRequestBuilder deleteMember(UUID chatId, UUID userId) {
        return delete("/api/v1/chats/{chatId}/members/{userId}", chatId, userId);
    }

    private MockHttpServletRequestBuilder getInvites(UUID chatId) {
        return get("/api/v1/chats/{chatId}/invites", chatId);
    }

    private MockHttpServletRequestBuilder postInvite(UUID chatId) {
        return post("/api/v1/chats/{chatId}/invites", chatId);
    }

    private MockHttpServletRequestBuilder deleteInvite(UUID chatId, UUID inviteId) {
        return delete("/api/v1/chats/{chatId}/invites/{inviteId}", chatId, inviteId);
    }

    private ResultActions createInvite(SessionResponse actor, UUID chatId, Map<String, Object> body)
            throws Exception {
        return mockMvc.perform(authed(post("/api/v1/chats/{chatId}/invites", chatId), actor)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(body)));
    }

    private ResultActions accept(SessionResponse actor, String token) throws Exception {
        return mockMvc.perform(authed(post("/api/v1/invites/{token}/accept", token), actor));
    }

    private MockHttpServletRequestBuilder block(UUID userId) {
        return post("/api/v1/users/{userId}/block", userId);
    }

    private MockHttpServletRequestBuilder unblock(UUID userId) {
        return delete("/api/v1/users/{userId}/block", userId);
    }

    private Map<String, Object> chatMember(UUID chatId, UUID userId) {
        List<Map<String, Object>> rows = migrator().queryForList("""
                SELECT role, status FROM chat.chat_members
                 WHERE chat_id = ? AND user_id = ?
                """, chatId, userId);
        assertThat(rows).as("membership %s/%s", chatId, userId).isNotEmpty();
        return rows.get(0);
    }

    private String visibility(UUID chatId) {
        List<String> rows = migrator().queryForList("""
                SELECT visibility FROM chat.channel_settings WHERE chat_id = ?
                """, String.class, chatId);
        return rows.isEmpty() ? null : rows.get(0);
    }

    private String emailOf(UUID userId) {
        return migrator().queryForObject(
                "SELECT email::text FROM auth.users WHERE id = ?", String.class, userId);
    }

    private String displayNameOf(UUID userId) {
        return migrator().queryForObject(
                "SELECT display_name FROM auth.users WHERE id = ?", String.class, userId);
    }

    private String inviteTokenHash(UUID inviteId) {
        return migrator().queryForObject(
                "SELECT token_hash FROM chat.invites WHERE id = ?", String.class, inviteId);
    }

    private UUID inviteIdByHash(String tokenHash) {
        return migrator().queryForObject(
                "SELECT id FROM chat.invites WHERE token_hash = ?", UUID.class, tokenHash);
    }

    private int inviteUsedCount(UUID inviteId) {
        return migrator().queryForObject(
                "SELECT used_count FROM chat.invites WHERE id = ?", Integer.class, inviteId);
    }

    private String inviteDbStatus(UUID inviteId) {
        Instant expiresAt = migrator().queryForObject(
                "SELECT expires_at FROM chat.invites WHERE id = ?", Instant.class, inviteId);
        Instant revokedAt = migrator().queryForObject(
                "SELECT revoked_at FROM chat.invites WHERE id = ?", Instant.class, inviteId);
        if (revokedAt != null) {
            return "REVOKED";
        }
        if (expiresAt != null && !expiresAt.isAfter(Instant.now())) {
            return "EXPIRED";
        }
        return "ACTIVE";
    }

    private boolean columnExists(String schema, String table, String column) {
        return Boolean.TRUE.equals(migrator().queryForObject("""
                SELECT EXISTS (
                    SELECT 1 FROM information_schema.columns
                     WHERE table_schema = ? AND table_name = ? AND column_name = ?
                )
                """, Boolean.class, schema, table, column));
    }

    private long blockCount(UUID blockerId, UUID blockedId) {
        return migrator().queryForObject("""
                SELECT count(*) FROM auth.user_blocks
                 WHERE blocker_id = ? AND blocked_id = ?
                """, Long.class, blockerId, blockedId);
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

    private long chatsUsedByUser(SessionResponse session) {
        return migrator().queryForObject("""
                SELECT count(*) FROM chat.chats c
                  JOIN chat.chat_members cm
                    ON cm.chat_id = c.id AND cm.user_id = ? AND cm.status = 'ACTIVE'
                 WHERE c.workspace_id = ? AND c.deleted_at IS NULL
                """, Long.class, session.user().id(), session.workspace().id());
    }

    private long chatsInWorkspace(SessionResponse session) {
        return migrator().queryForObject("""
                SELECT count(*) FROM chat.chats
                 WHERE workspace_id = ? AND deleted_at IS NULL
                """, Long.class, session.workspace().id());
    }

    private void setChatLimits(long perUser, long perWorkspace) {
        migrator().update("""
                UPDATE ops.system_settings
                   SET max_chats_per_user = ?, max_chats_per_workspace = ?
                 WHERE id = 1
                """, perUser, perWorkspace);
    }
}
