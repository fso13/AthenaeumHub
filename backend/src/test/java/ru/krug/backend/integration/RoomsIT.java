package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.time.Instant;
import java.util.HashMap;
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

import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.room.application.usecase.RoomPresenceCleanupService;
import ru.krug.backend.shared.application.model.IssuedToken;
import ru.krug.backend.shared.application.port.TokenIssuer;
import ru.krug.backend.support.IntegrationTestBase;
import ru.krug.backend.support.OpenApiContract;

/**
 * #105 Rooms backend slice: room + backing managed GROUP channel, ACTIVE-member permissions,
 * rename/soft-close, TTL presence heartbeat, installation chat limits, E2EE rejection and
 * RLS/grants. No call/SFU/media state is involved; the backing channel is used by the
 * existing call signalling.
 */
@ActiveProfiles("test")
class RoomsIT extends IntegrationTestBase {

    private static final OpenApiContract CONTRACT = OpenApiContract.load();

    @Autowired
    private TokenIssuer tokenIssuer;

    @Autowired
    private RoomPresenceCleanupService presenceCleanup;

    @AfterEach
    void restoreChatLimits() {
        migrator().update("""
                UPDATE ops.system_settings
                   SET max_chats_per_user = 100, max_chats_per_workspace = 1000
                 WHERE id = 1
                """);
    }

    @Test
    void createsRoomWithBackingManagedChannelForEveryActiveMember() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("room-create-owner"));
        SessionResponse creator = devSession(uniqueDisplayName("room-create-creator"));
        UUID workspaceId = owner.workspace().id();
        addMember(owner, workspaceId, emailOf(creator.user().id()), "MEMBER")
                .andExpect(status().isCreated());

        SessionResponse creatorScoped = scoped(creator, workspaceId);
        MvcResult created = createRoom(creatorScoped, workspaceId, "  Team Room  ")
                .andExpect(status().isCreated()).andReturn();
        JsonNode body = json(created);
        CONTRACT.assertValid("Room", body);

        UUID roomId = UUID.fromString(body.get("id").asText());
        UUID chatId = UUID.fromString(body.get("chat_id").asText());
        assertThat(body.get("workspace_id").asText()).isEqualTo(workspaceId.toString());
        assertThat(body.get("name").asText()).isEqualTo("Team Room");
        assertThat(body.get("created_by").asText()).isEqualTo(creator.user().id().toString());
        assertThat(body.get("status").asText()).isEqualTo("ACTIVE");
        assertThat(body.get("media_mode").asText()).isEqualTo("VIDEO");
        assertThat(body.get("participant_count").asInt()).isZero();
        assertThat(body.get("my_present").asBoolean()).isFalse();
        assertThat(body.get("participants")).isEmpty();

        Map<String, Object> room = roomRow(roomId);
        assertThat(room.get("workspace_id")).isEqualTo(workspaceId);
        assertThat(room.get("chat_id")).isEqualTo(chatId);
        assertThat(room.get("name")).isEqualTo("Team Room");
        assertThat(room.get("created_by")).isEqualTo(creator.user().id());
        assertThat(room.get("status")).isEqualTo("ACTIVE");
        assertThat(room.get("media_mode")).isEqualTo("VIDEO");

        Map<String, Object> chat = migrator().queryForMap("""
                SELECT workspace_id, type, security_mode, name, created_by, deleted_at
                  FROM chat.chats WHERE id = ?
                """, chatId);
        assertThat(chat.get("workspace_id")).isEqualTo(workspaceId);
        assertThat(chat.get("type")).isEqualTo("GROUP");
        assertThat(chat.get("security_mode")).isEqualTo("MANAGED");
        assertThat(chat.get("name")).isEqualTo("Team Room");
        assertThat(chat.get("created_by")).isEqualTo(creator.user().id());
        assertThat(chat.get("deleted_at")).isNull();

        // Creator is OWNER; every ACTIVE workspace member (including the workspace OWNER)
        // is an ACTIVE participant of the backing channel.
        assertThat(memberRow(chatId, creator.user().id()).get("role")).isEqualTo("OWNER");
        assertThat(memberRow(chatId, creator.user().id()).get("status")).isEqualTo("ACTIVE");
        assertThat(memberRow(chatId, owner.user().id()).get("role")).isEqualTo("MEMBER");
        assertThat(memberRow(chatId, owner.user().id()).get("status")).isEqualTo("ACTIVE");
        assertThat(visibilityRow(chatId)).isEqualTo("PUBLIC");
        assertThat(joinPolicy(chatId)).isEqualTo("OPEN");
        assertThat(chatCounterExists(chatId)).isTrue();

        // Both audit trails are metadata-only.
        Map<String, Object> roomAudit = migrator().queryForMap("""
                SELECT actor_id, target_type, target_id, metadata::text AS metadata
                  FROM audit.audit_events
                 WHERE action = 'room.created' AND target_id = ?
                """, roomId);
        assertThat(roomAudit.get("actor_id")).isEqualTo(creator.user().id());
        assertThat(roomAudit.get("target_type")).isEqualTo("room");
        JsonNode roomMeta = objectMapper.readTree(String.valueOf(roomAudit.get("metadata")));
        assertThat(roomMeta.fieldNames()).toIterable()
                .containsExactlyInAnyOrder("chat_id", "status");
        assertThat(roomMeta.get("chat_id").asText()).isEqualTo(chatId.toString());
        assertThat(roomMeta.get("status").asText()).isEqualTo("ACTIVE");

        Map<String, Object> chatAudit = migrator().queryForMap("""
                SELECT actor_id, metadata::text AS metadata
                  FROM audit.audit_events
                 WHERE action = 'chat.created' AND target_id = ?
                """, chatId);
        assertThat(chatAudit.get("actor_id")).isEqualTo(creator.user().id());
        JsonNode chatMeta = objectMapper.readTree(String.valueOf(chatAudit.get("metadata")));
        assertThat(chatMeta.fieldNames()).toIterable()
                .containsExactlyInAnyOrder("visibility", "member_count");
        assertThat(chatMeta.get("visibility").asText()).isEqualTo("PUBLIC");
        assertThat(chatMeta.get("member_count").asInt()).isEqualTo(2);

        // The workspace OWNER (not the room creator) still sees the room and its detail.
        JsonNode list = listRooms(owner, workspaceId);
        CONTRACT.assertValid("RoomList", list);
        assertThat(list.get("items")).hasSize(1);
        assertThat(list.at("/items/0/id").asText()).isEqualTo(roomId.toString());
        assertThat(list.at("/items/0/participant_count").asInt()).isZero();

        JsonNode detail = json(getRoom(owner, roomId).andExpect(status().isOk()).andReturn());
        CONTRACT.assertValid("Room", detail);
        assertThat(detail.get("id").asText()).isEqualTo(roomId.toString());
        assertThat(detail.get("chat_id").asText()).isEqualTo(chatId.toString());
        assertThat(detail.get("media_mode").asText()).isEqualTo("VIDEO");
    }

    @Test
    void listsOnlyPresentParticipantsInsideTheTtlAndReportsMyPresent() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("room-ttl-owner"));
        SessionResponse member = devSession(uniqueDisplayName("room-ttl-member"));
        UUID workspaceId = owner.workspace().id();
        addMember(owner, workspaceId, emailOf(member.user().id()), "MEMBER")
                .andExpect(status().isCreated());
        SessionResponse memberScoped = scoped(member, workspaceId);
        UUID roomId = UUID.fromString(createRoomOk(owner, workspaceId, "TTL Room")
                .get("id").asText());

        heartbeat(memberScoped, roomId).andExpect(status().isNoContent());

        JsonNode ownerView = listRooms(owner, workspaceId);
        CONTRACT.assertValid("RoomList", ownerView);
        assertThat(ownerView.at("/items/0/participant_count").asInt()).isEqualTo(1);
        assertThat(ownerView.at("/items/0/my_present").asBoolean()).isFalse();
        JsonNode participant = ownerView.at("/items/0/participants/0");
        CONTRACT.assertValid("RoomParticipant", participant);
        assertThat(participant.get("user_id").asText()).isEqualTo(member.user().id().toString());
        assertThat(participant.get("display_name").asText())
                .startsWith("room-ttl-member");

        JsonNode memberView = listRooms(memberScoped, workspaceId);
        assertThat(memberView.at("/items/0/my_present").asBoolean()).isTrue();
        assertThat(memberView.at("/items/0/participant_count").asInt()).isEqualTo(1);

        // Move the heartbeat outside the 30 s TTL: the row remains in the table but every
        // read ignores it, and the cleanup service physically removes it.
        migrator().update("""
                UPDATE room.presence
                   SET last_seen_at = now() - interval '31 seconds'
                 WHERE room_id = ? AND user_id = ?
                """, roomId, member.user().id());
        JsonNode stale = listRooms(memberScoped, workspaceId);
        assertThat(stale.at("/items/0/participant_count").asInt()).isZero();
        assertThat(stale.at("/items/0/my_present").asBoolean()).isFalse();
        assertThat(stale.at("/items/0/participants")).isEmpty();

        assertThat(presenceCleanup.cleanup()).isPositive();
        assertThat(presenceCount(roomId)).isZero();

        // A new heartbeat after the TTL starts a fresh presence row.
        heartbeat(memberScoped, roomId).andExpect(status().isNoContent());
        JsonNode fresh = listRooms(memberScoped, workspaceId);
        assertThat(fresh.at("/items/0/participant_count").asInt()).isEqualTo(1);
        assertThat(fresh.at("/items/0/my_present").asBoolean()).isTrue();
    }

    @Test
    void heartbeatPreservesJoinedAtAndLeaveIsIdempotent() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("room-beat-owner"));
        SessionResponse member = devSession(uniqueDisplayName("room-beat-member"));
        UUID workspaceId = owner.workspace().id();
        addMember(owner, workspaceId, emailOf(member.user().id()), "MEMBER")
                .andExpect(status().isCreated());
        SessionResponse memberScoped = scoped(member, workspaceId);
        UUID roomId = UUID.fromString(createRoomOk(owner, workspaceId, "Heartbeat Room")
                .get("id").asText());

        heartbeat(memberScoped, roomId).andExpect(status().isNoContent());
        heartbeat(memberScoped, roomId).andExpect(status().isNoContent());
        assertThat(presenceCount(roomId)).isEqualTo(1);

        // A heartbeat inside the TTL must preserve joined_at (it is the same session),
        // while updating last_seen_at.
        migrator().update("""
                UPDATE room.presence
                   SET joined_at = now() - interval '1 hour',
                       last_seen_at = now() - interval '10 seconds'
                 WHERE room_id = ? AND user_id = ?
                """, roomId, member.user().id());
        heartbeat(memberScoped, roomId).andExpect(status().isNoContent());
        Map<String, Object> row = presenceRow(roomId, member.user().id());
        Instant joinedAt = ((java.sql.Timestamp) row.get("joined_at")).toInstant();
        Instant lastSeenAt = ((java.sql.Timestamp) row.get("last_seen_at")).toInstant();
        assertThat(joinedAt).isBefore(Instant.now().minusSeconds(30 * 60));
        assertThat(lastSeenAt).isAfter(Instant.now().minusSeconds(10));

        leave(memberScoped, roomId).andExpect(status().isNoContent());
        assertThat(presenceCount(roomId)).isZero();
        // Idempotent: no row is still a 204.
        leave(memberScoped, roomId).andExpect(status().isNoContent());
        assertThat(presenceCount(roomId)).isZero();

        // Re-joining after a leave creates a fresh joined_at.
        heartbeat(memberScoped, roomId).andExpect(status().isNoContent());
        Map<String, Object> rejoin = presenceRow(roomId, member.user().id());
        Instant rejoinJoinedAt = ((java.sql.Timestamp) rejoin.get("joined_at")).toInstant();
        assertThat(rejoinJoinedAt).isAfter(joinedAt);
    }

    @Test
    void enforcesRenameAndClosePermissionsAndClosedRoomRules() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("room-perm-owner"));
        SessionResponse creator = devSession(uniqueDisplayName("room-perm-creator"));
        SessionResponse other = devSession(uniqueDisplayName("room-perm-other"));
        SessionResponse admin = devSession(uniqueDisplayName("room-perm-admin"));
        UUID workspaceId = owner.workspace().id();
        addMember(owner, workspaceId, emailOf(creator.user().id()), "MEMBER")
                .andExpect(status().isCreated());
        addMember(owner, workspaceId, emailOf(other.user().id()), "MEMBER")
                .andExpect(status().isCreated());
        addMember(owner, workspaceId, emailOf(admin.user().id()), "ADMIN")
                .andExpect(status().isCreated());

        SessionResponse creatorScoped = scoped(creator, workspaceId);
        SessionResponse otherScoped = scoped(other, workspaceId);
        SessionResponse adminScoped = scoped(admin, workspaceId);
        UUID roomId = UUID.fromString(createRoomOk(creatorScoped, workspaceId, "Perm Room")
                .get("id").asText());
        UUID chatId = UUID.fromString(json(getRoom(owner, roomId)
                .andExpect(status().isOk()).andReturn()).get("chat_id").asText());

        // A plain member who is not the creator cannot rename or close the room.
        renameRoom(otherScoped, workspaceId, roomId, "Hijack").andExpect(status().isForbidden());
        closeRoom(otherScoped, workspaceId, roomId).andExpect(status().isForbidden());

        // Workspace ADMIN may rename, but close requires the creator or workspace OWNER.
        renameRoom(adminScoped, workspaceId, roomId, "Admin Renamed")
                .andExpect(status().isOk());
        assertThat(chatName(chatId)).isEqualTo("Admin Renamed");
        closeRoom(adminScoped, workspaceId, roomId).andExpect(status().isForbidden());

        // Workspace OWNER can rename and close somebody else's room.
        renameRoom(owner, workspaceId, roomId, "Owner Renamed").andExpect(status().isOk());
        closeRoom(owner, workspaceId, roomId).andExpect(status().isNoContent());
        closeRoom(owner, workspaceId, roomId).andExpect(status().isNoContent());

        assertThat(roomRow(roomId).get("status")).isEqualTo("CLOSED");
        assertThat(chatDeletedAt(chatId)).isNotNull();
        JsonNode closed = json(getRoom(owner, roomId).andExpect(status().isOk()).andReturn());
        CONTRACT.assertValid("Room", closed);
        assertThat(closed.get("status").asText()).isEqualTo("CLOSED");
        assertThat(closed.get("participant_count").asInt()).isZero();
        assertThat(listRooms(owner, workspaceId).get("items")).isEmpty();

        // Closed room: rename and join are rejected, leave stays idempotent.
        renameRoom(owner, workspaceId, roomId, "Nope")
                .andExpect(status().isConflict());
        heartbeat(owner, roomId).andExpect(status().isConflict());
        leave(owner, roomId).andExpect(status().isNoContent());

        // The creator may close their own room.
        UUID second = UUID.fromString(createRoomOk(creatorScoped, workspaceId,
                "Creator Room").get("id").asText());
        closeRoom(creatorScoped, workspaceId, second).andExpect(status().isNoContent());
        assertThat(roomRow(second).get("status")).isEqualTo("CLOSED");
        assertThat(listRooms(owner, workspaceId).get("items")).isEmpty();

        // An outsider (not an ACTIVE workspace member) cannot list, create, read or join.
        SessionResponse outsider = devSession(uniqueDisplayName("room-perm-outsider"));
        listRoomsAction(outsider, workspaceId).andExpect(status().isForbidden());
        createRoom(outsider, workspaceId, "Nope").andExpect(status().isForbidden());
        getRoom(outsider, roomId).andExpect(status().isNotFound());
        heartbeat(outsider, roomId).andExpect(status().isNotFound());
    }

    @Test
    void enforcesInstallationChatLimitsWithoutPartialRooms() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("room-limit-owner"));
        UUID workspaceId = owner.workspace().id();
        long roomsBefore = roomCount(workspaceId);
        long chatsBefore = chatCount(workspaceId);

        // The dev workspace already has one chat, so a per-user limit of 1 is exhausted.
        setChatLimits(1, 1000);
        JsonNode userLimited = json(createRoom(owner, workspaceId, "Limited")
                .andExpect(status().isConflict()).andReturn());
        CONTRACT.assertValid("Error", userLimited);
        assertThat(userLimited.get("code").asText()).isEqualTo("CHAT_LIMIT_REACHED");
        assertThat(userLimited.at("/details/scope").asText()).isEqualTo("USER");
        assertThat(roomCount(workspaceId)).isEqualTo(roomsBefore);
        assertThat(chatCount(workspaceId)).isEqualTo(chatsBefore);

        setChatLimits(100, 1);
        JsonNode workspaceLimited = json(createRoom(owner, workspaceId, "Limited")
                .andExpect(status().isConflict()).andReturn());
        assertThat(workspaceLimited.get("code").asText()).isEqualTo("CHAT_LIMIT_REACHED");
        assertThat(workspaceLimited.at("/details/scope").asText()).isEqualTo("WORKSPACE");
        assertThat(roomCount(workspaceId)).isEqualTo(roomsBefore);
        assertThat(chatCount(workspaceId)).isEqualTo(chatsBefore);

        setChatLimits(100, 1000);
        createRoomOk(owner, workspaceId, "Within Limit");
        assertThat(roomCount(workspaceId)).isEqualTo(roomsBefore + 1);
        assertThat(chatCount(workspaceId)).isEqualTo(chatsBefore + 1);

        // A failed second create leaves neither a room row nor a chat row behind.
        setChatLimits(1, 1);
        createRoom(owner, workspaceId, "Another").andExpect(status().isConflict());
        assertThat(roomCount(workspaceId)).isEqualTo(roomsBefore + 1);
        assertThat(chatCount(workspaceId)).isEqualTo(chatsBefore + 1);
    }

    @Test
    void rejectsInvalidNamesAndE2eeWorkspaces() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("room-invalid-owner"));
        UUID workspaceId = owner.workspace().id();

        createRoom(owner, workspaceId, "").andExpect(status().isBadRequest());
        createRoom(owner, workspaceId, "x".repeat(121)).andExpect(status().isBadRequest());
        assertThat(roomCount(workspaceId)).isZero();

        // Rooms are MANAGED-only: an E2EE workspace cannot create a plaintext channel.
        // security_mode is immutable, so the fixture is inserted directly as an E2EE
        // workspace (the API path is blocked by the disabled E2EE feature flag in tests).
        UUID e2eeWorkspace = UUID.randomUUID();
        migrator().update("""
                INSERT INTO workspace.workspaces
                       (id, name, slug, security_mode, created_by)
                VALUES (?, 'E2EE fixture', ?, 'E2EE', ?)
                """, e2eeWorkspace, "e2ee-" + UUID.randomUUID(), owner.user().id());
        migrator().update("""
                INSERT INTO workspace.memberships (workspace_id, user_id, role, status)
                VALUES (?, ?, 'OWNER', 'ACTIVE')
                """, e2eeWorkspace, owner.user().id());
        SessionResponse e2eeScoped = scoped(owner, e2eeWorkspace);
        JsonNode e2ee = json(createRoom(e2eeScoped, e2eeWorkspace, "E2EE Room")
                .andExpect(status().isConflict()).andReturn());
        CONTRACT.assertValid("Error", e2ee);
        assertThat(e2ee.get("code").asText()).isEqualTo("E2EE_GROUP_NOT_SUPPORTED");
        assertThat(roomCount(e2eeWorkspace)).isZero();
        assertThat(chatCount(e2eeWorkspace)).isZero();
    }

    @Test
    void roomsPresenceAndFunctionsRespectTenantRls() throws Exception {
        for (String table : List.of("room.rooms", "room.presence")) {
            Map<String, Object> flags = migrator().queryForMap("""
                    SELECT relrowsecurity, relforcerowsecurity FROM pg_class
                     WHERE oid = ?::regclass
                    """, table);
            assertThat(flags.get("relrowsecurity")).as(table).isEqualTo(true);
            assertThat(flags.get("relforcerowsecurity")).as(table).isEqualTo(true);
            for (String privilege : new String[]{"SELECT", "INSERT", "UPDATE", "DELETE"}) {
                assertThat(migrator().queryForObject(
                        "SELECT has_table_privilege('krug_app', ?, ?)",
                        Boolean.class, table, privilege)).as(table + " " + privilege).isTrue();
            }
        }
        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM pg_constraint
                 WHERE conrelid = 'room.rooms'::regclass AND contype = 'f'
                """, Long.class)).isEqualTo(2L);
        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM pg_constraint
                 WHERE conrelid = 'room.presence'::regclass AND contype = 'f'
                """, Long.class)).isEqualTo(2L);
        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM pg_constraint
                 WHERE conrelid = 'room.rooms'::regclass AND conname = 'uq_rooms_chat'
                """, Long.class)).isEqualTo(1L);
        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM pg_policy
                 WHERE polrelid = 'room.rooms'::regclass
                """, Long.class)).isEqualTo(2L);

        SessionResponse ownerA = devSession(uniqueDisplayName("room-rls-a"));
        SessionResponse ownerB = devSession(uniqueDisplayName("room-rls-b"));
        UUID workspaceA = ownerA.workspace().id();
        UUID workspaceB = ownerB.workspace().id();
        UUID chatA = ownerA.chat().id();
        UUID chatB = ownerB.chat().id();
        UUID roomA = UUID.randomUUID();
        UUID roomB = UUID.randomUUID();

        inTenant(ownerA.user().id(), workspaceA, () -> jdbc.update("""
                INSERT INTO room.rooms
                       (id, workspace_id, chat_id, name, created_by)
                VALUES (?, ?, ?, 'A', ?)
                """, roomA, workspaceA, chatA, ownerA.user().id()));
        inTenant(ownerB.user().id(), workspaceB, () -> jdbc.update("""
                INSERT INTO room.rooms
                       (id, workspace_id, chat_id, name, created_by)
                VALUES (?, ?, ?, 'B', ?)
                """, roomB, workspaceB, chatB, ownerB.user().id()));
        inTenant(ownerA.user().id(), workspaceA, () -> jdbc.update("""
                INSERT INTO room.presence (room_id, user_id)
                VALUES (?, ?)
                """, roomA, ownerA.user().id()));
        inTenant(ownerB.user().id(), workspaceB, () -> jdbc.update("""
                INSERT INTO room.presence (room_id, user_id)
                VALUES (?, ?)
                """, roomB, ownerB.user().id()));

        // Tenant A sees only A's room/presence through the runtime role.
        assertThat(inTenant(ownerA.user().id(), workspaceA, () ->
                jdbc.queryForObject("SELECT count(*) FROM room.rooms", Long.class)))
                .isEqualTo(1L);
        assertThat(inTenant(ownerB.user().id(), workspaceB, () ->
                jdbc.queryForObject("SELECT count(*) FROM room.rooms", Long.class)))
                .isEqualTo(1L);
        assertThat(inTenant(ownerA.user().id(), workspaceA, () ->
                jdbc.queryForObject("SELECT count(*) FROM room.presence", Long.class)))
                .isEqualTo(1L);
        assertThat(inTenant(ownerB.user().id(), workspaceB, () ->
                jdbc.queryForObject("SELECT count(*) FROM room.presence", Long.class)))
                .isEqualTo(1L);

        // WITH CHECK: a row for another tenant cannot be written under A's GUC.
        assertThatThrownBy(() -> inTenant(ownerA.user().id(), workspaceA, () -> jdbc.update("""
                INSERT INTO room.rooms
                       (id, workspace_id, chat_id, name, created_by)
                VALUES (?, ?, ?, 'cross', ?)
                """, UUID.randomUUID(), workspaceB, chatB, ownerA.user().id())))
                .isInstanceOf(DataAccessException.class);
        assertThatThrownBy(() -> inTenant(ownerA.user().id(), workspaceA, () -> jdbc.update("""
                INSERT INTO room.presence (room_id, user_id)
                VALUES (?, ?)
                """, roomB, ownerA.user().id())))
                .isInstanceOf(DataAccessException.class);

        // room_scope()/presence_directory() are bound to the caller GUC and active membership.
        assertThat(inTenant(ownerA.user().id(), workspaceA, () ->
                jdbc.queryForList("""
                        SELECT workspace_id FROM room.room_scope(?, ?)
                        """, roomA, ownerA.user().id()))).hasSize(1);
        assertThat(inTenant(ownerB.user().id(), workspaceB, () ->
                jdbc.queryForList("""
                        SELECT workspace_id FROM room.room_scope(?, ?)
                        """, roomA, ownerB.user().id()))).isEmpty();
        assertThat(inTenant(ownerA.user().id(), workspaceA, () ->
                jdbc.queryForList("""
                        SELECT user_id FROM room.presence_directory(?, ?,
                                                                    now() - interval '30 seconds')
                        """, workspaceA, ownerA.user().id()))).hasSize(1);
        assertThat(inTenant(ownerB.user().id(), workspaceB, () ->
                jdbc.queryForList("""
                        SELECT user_id FROM room.presence_directory(?, ?,
                                                                    now() - interval '30 seconds')
                        """, workspaceA, ownerB.user().id()))).isEmpty();

        // The TTL cleanup function is deliberately cross-tenant and removes both stale rows.
        migrator().update("""
                UPDATE room.presence SET last_seen_at = now() - interval '1 hour'
                 WHERE room_id IN (?, ?)
                """, roomA, roomB);
        assertThat(presenceCleanup.cleanup()).isGreaterThanOrEqualTo(2);
        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM room.presence WHERE room_id IN (?, ?)
                """, Long.class, roomA, roomB)).isZero();
    }

    @Test
    void createsRoomsWithDefaultAndExplicitMediaMode() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("room-mode-create"));
        UUID workspaceId = owner.workspace().id();

        // No media_mode in the request -> server default VIDEO.
        JsonNode defaultRoom = createRoomOk(owner, workspaceId, "Default Mode");
        CONTRACT.assertValid("Room", defaultRoom);
        UUID defaultId = UUID.fromString(defaultRoom.get("id").asText());
        assertThat(defaultRoom.get("media_mode").asText()).isEqualTo("VIDEO");
        assertThat(roomRow(defaultId).get("media_mode")).isEqualTo("VIDEO");

        JsonNode audio = createRoomOk(owner, workspaceId, "Audio Room", "AUDIO");
        CONTRACT.assertValid("Room", audio);
        UUID audioId = UUID.fromString(audio.get("id").asText());
        assertThat(audio.get("name").asText()).isEqualTo("Audio Room");
        assertThat(audio.get("media_mode").asText()).isEqualTo("AUDIO");
        assertThat(roomRow(audioId).get("media_mode")).isEqualTo("AUDIO");

        JsonNode video = createRoomOk(owner, workspaceId, "Video Room", "VIDEO");
        CONTRACT.assertValid("Room", video);
        UUID videoId = UUID.fromString(video.get("id").asText());
        assertThat(video.get("media_mode").asText()).isEqualTo("VIDEO");
        assertThat(roomRow(videoId).get("media_mode")).isEqualTo("VIDEO");

        JsonNode list = listRooms(owner, workspaceId);
        CONTRACT.assertValid("RoomList", list);
        assertThat(list.get("items")).hasSize(3);
        Map<String, String> modes = new HashMap<>();
        list.get("items").forEach(item -> modes.put(item.get("id").asText(),
                item.get("media_mode").asText()));
        assertThat(modes)
                .containsEntry(defaultId.toString(), "VIDEO")
                .containsEntry(audioId.toString(), "AUDIO")
                .containsEntry(videoId.toString(), "VIDEO");

        JsonNode detail = json(getRoom(owner, audioId).andExpect(status().isOk()).andReturn());
        CONTRACT.assertValid("Room", detail);
        assertThat(detail.get("media_mode").asText()).isEqualTo("AUDIO");

        // An explicit JSON null is treated like an omitted field (VIDEO default).
        Map<String, Object> explicitNull = new LinkedHashMap<>();
        explicitNull.put("name", "Null Mode");
        explicitNull.put("media_mode", null);
        JsonNode nullRoom = json(createRoomBody(owner, workspaceId, explicitNull)
                .andExpect(status().isCreated()).andReturn());
        CONTRACT.assertValid("Room", nullRoom);
        assertThat(nullRoom.get("media_mode").asText()).isEqualTo("VIDEO");
    }

    @Test
    void updatesMediaModeWithCreatorOwnerAdminPermissionsAndValidation() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("room-mode-owner"));
        SessionResponse creator = devSession(uniqueDisplayName("room-mode-creator"));
        SessionResponse admin = devSession(uniqueDisplayName("room-mode-admin"));
        SessionResponse member = devSession(uniqueDisplayName("room-mode-member"));
        UUID workspaceId = owner.workspace().id();
        addMember(owner, workspaceId, emailOf(creator.user().id()), "MEMBER")
                .andExpect(status().isCreated());
        addMember(owner, workspaceId, emailOf(admin.user().id()), "ADMIN")
                .andExpect(status().isCreated());
        addMember(owner, workspaceId, emailOf(member.user().id()), "MEMBER")
                .andExpect(status().isCreated());
        SessionResponse creatorScoped = scoped(creator, workspaceId);
        SessionResponse adminScoped = scoped(admin, workspaceId);
        SessionResponse memberScoped = scoped(member, workspaceId);

        JsonNode created = createRoomOk(creatorScoped, workspaceId, "Audio Sync", "AUDIO");
        UUID roomId = UUID.fromString(created.get("id").asText());
        UUID chatId = UUID.fromString(created.get("chat_id").asText());

        // A plain member who is not the creator cannot change the mode.
        patchMediaMode(memberScoped, workspaceId, roomId, "VIDEO")
                .andExpect(status().isForbidden());
        assertThat(roomRow(roomId).get("media_mode")).isEqualTo("AUDIO");

        // The creator changes only the mode: the name and the backing channel are untouched.
        JsonNode byCreator = json(patchMediaMode(creatorScoped, workspaceId, roomId, "VIDEO")
                .andExpect(status().isOk()).andReturn());
        CONTRACT.assertValid("Room", byCreator);
        assertThat(byCreator.get("name").asText()).isEqualTo("Audio Sync");
        assertThat(byCreator.get("media_mode").asText()).isEqualTo("VIDEO");
        assertThat(roomRow(roomId).get("media_mode")).isEqualTo("VIDEO");
        assertThat(chatName(chatId)).isEqualTo("Audio Sync");
        List<Map<String, Object>> modeAudits = mediaModeAudits(roomId);
        assertThat(modeAudits).hasSize(1);
        assertMediaModeAudit(modeAudits.get(0), creator.user().id(), "VIDEO");

        // Repeating the same value is an idempotent 200 with no extra audit row.
        patchMediaMode(creatorScoped, workspaceId, roomId, "VIDEO")
                .andExpect(status().isOk());
        assertThat(mediaModeAudits(roomId)).hasSize(1);

        // Workspace ADMIN may change the mode too.
        JsonNode byAdmin = json(patchMediaMode(adminScoped, workspaceId, roomId, "AUDIO")
                .andExpect(status().isOk()).andReturn());
        CONTRACT.assertValid("Room", byAdmin);
        assertThat(byAdmin.get("media_mode").asText()).isEqualTo("AUDIO");
        assertThat(roomRow(roomId).get("media_mode")).isEqualTo("AUDIO");
        assertThat(mediaModeAudits(roomId)).hasSize(2);

        // Workspace OWNER may rename and change the mode in one partial PATCH.
        Map<String, Object> both = new LinkedHashMap<>();
        both.put("name", "Owner Video");
        both.put("media_mode", "VIDEO");
        JsonNode byOwner = json(patchRoom(owner, workspaceId, roomId, both)
                .andExpect(status().isOk()).andReturn());
        CONTRACT.assertValid("Room", byOwner);
        assertThat(byOwner.get("name").asText()).isEqualTo("Owner Video");
        assertThat(byOwner.get("media_mode").asText()).isEqualTo("VIDEO");
        assertThat(roomRow(roomId).get("name")).isEqualTo("Owner Video");
        assertThat(roomRow(roomId).get("media_mode")).isEqualTo("VIDEO");
        assertThat(chatName(chatId)).isEqualTo("Owner Video");
        assertThat(mediaModeAudits(roomId)).hasSize(3);

        Map<String, Object> renamedAudit = migrator().queryForMap("""
                SELECT actor_id, metadata::text AS metadata
                  FROM audit.audit_events
                 WHERE action = 'room.renamed' AND target_id = ?
                 ORDER BY seq DESC LIMIT 1
                """, roomId);
        assertThat(renamedAudit.get("actor_id")).isEqualTo(owner.user().id());
        JsonNode renamedMeta = objectMapper.readTree(
                String.valueOf(renamedAudit.get("metadata")));
        assertThat(renamedMeta.fieldNames()).toIterable().containsExactly("chat_id");
        assertThat(renamedMeta.get("chat_id").asText()).isEqualTo(chatId.toString());

        // A name-only PATCH keeps the current media mode.
        JsonNode renamedOnly = json(renameRoom(creatorScoped, workspaceId, roomId,
                "Creator Rename").andExpect(status().isOk()).andReturn());
        CONTRACT.assertValid("Room", renamedOnly);
        assertThat(renamedOnly.get("name").asText()).isEqualTo("Creator Rename");
        assertThat(renamedOnly.get("media_mode").asText()).isEqualTo("VIDEO");
        assertThat(roomRow(roomId).get("media_mode")).isEqualTo("VIDEO");

        // Unknown, lowercase and empty PATCHes are rejected without any state change.
        patchMediaMode(owner, workspaceId, roomId, "MUSIC")
                .andExpect(status().isBadRequest());
        patchMediaMode(owner, workspaceId, roomId, "audio")
                .andExpect(status().isBadRequest());
        patchRoom(owner, workspaceId, roomId, Map.of()).andExpect(status().isBadRequest());
        createRoom(owner, workspaceId, "Bad Mode", "MUSIC")
                .andExpect(status().isBadRequest());
        createRoom(owner, workspaceId, "Bad Lowercase", "audio")
                .andExpect(status().isBadRequest());
        assertThat(roomCount(workspaceId)).isEqualTo(1);
        assertThat(roomRow(roomId).get("media_mode")).isEqualTo("VIDEO");
        assertThat(chatName(chatId)).isEqualTo("Creator Rename");

        // A CLOSED room cannot change its media mode.
        closeRoom(owner, workspaceId, roomId).andExpect(status().isNoContent());
        patchMediaMode(creatorScoped, workspaceId, roomId, "AUDIO")
                .andExpect(status().isConflict());
        assertThat(roomRow(roomId).get("media_mode")).isEqualTo("VIDEO");
    }

    @Test
    void mediaModeMigrationIsNotNullDefaultedAndConstrained() throws Exception {
        Map<String, Object> column = migrator().queryForMap("""
                SELECT data_type, is_nullable, column_default
                  FROM information_schema.columns
                 WHERE table_schema = 'room'
                   AND table_name = 'rooms'
                   AND column_name = 'media_mode'
                """);
        assertThat(column.get("data_type")).isEqualTo("text");
        assertThat(column.get("is_nullable")).isEqualTo("NO");
        assertThat(String.valueOf(column.get("column_default"))).contains("'VIDEO'");

        String check = migrator().queryForObject("""
                SELECT pg_get_constraintdef(oid) FROM pg_constraint
                 WHERE conrelid = 'room.rooms'::regclass
                   AND conname = 'ck_rooms_media_mode'
                """, String.class);
        assertThat(check).contains("AUDIO").contains("VIDEO");

        SessionResponse owner = devSession(uniqueDisplayName("room-mode-migration"));
        UUID workspaceId = owner.workspace().id();
        UUID chatId = owner.chat().id();
        UUID roomId = UUID.randomUUID();
        // Legacy/direct writer omitting the column gets the VIDEO default.
        migrator().update("""
                INSERT INTO room.rooms (id, workspace_id, chat_id, name, created_by)
                VALUES (?, ?, ?, 'Legacy', ?)
                """, roomId, workspaceId, chatId, owner.user().id());
        assertThat(roomRow(roomId).get("media_mode")).isEqualTo("VIDEO");

        migrator().update("UPDATE room.rooms SET media_mode = 'AUDIO' WHERE id = ?", roomId);
        assertThat(roomRow(roomId).get("media_mode")).isEqualTo("AUDIO");

        // The DB backstop rejects both an unknown value and an explicit NULL.
        assertThatThrownBy(() -> migrator().update(
                "UPDATE room.rooms SET media_mode = 'MUSIC' WHERE id = ?", roomId))
                .isInstanceOf(DataAccessException.class)
                .hasMessageContaining("ck_rooms_media_mode");
        assertThatThrownBy(() -> migrator().update(
                "UPDATE room.rooms SET media_mode = NULL WHERE id = ?", roomId))
                .isInstanceOf(DataAccessException.class)
                .hasMessageContaining("media_mode");
        assertThat(roomRow(roomId).get("media_mode")).isEqualTo("AUDIO");
    }

    // ------------------------------------------------------------------

    private ResultActions createRoom(SessionResponse actor, UUID workspaceId, String name)
            throws Exception {
        return createRoom(actor, workspaceId, name, null);
    }

    private ResultActions createRoom(SessionResponse actor, UUID workspaceId, String name,
                                     String mediaMode) throws Exception {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("name", name);
        if (mediaMode != null) {
            body.put("media_mode", mediaMode);
        }
        return mockMvc.perform(authed(
                        post("/api/v1/workspaces/{workspaceId}/rooms", workspaceId), actor)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(body)));
    }

    private JsonNode createRoomOk(SessionResponse actor, UUID workspaceId, String name)
            throws Exception {
        return createRoomOk(actor, workspaceId, name, null);
    }

    private JsonNode createRoomOk(SessionResponse actor, UUID workspaceId, String name,
                                  String mediaMode) throws Exception {
        return json(createRoom(actor, workspaceId, name, mediaMode)
                .andExpect(status().isCreated()).andReturn());
    }

    private ResultActions createRoomBody(SessionResponse actor, UUID workspaceId,
                                         Map<String, Object> body) throws Exception {
        return mockMvc.perform(authed(
                        post("/api/v1/workspaces/{workspaceId}/rooms", workspaceId), actor)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(body)));
    }

    private JsonNode listRooms(SessionResponse actor, UUID workspaceId) throws Exception {
        return json(mockMvc.perform(authed(
                        get("/api/v1/workspaces/{workspaceId}/rooms", workspaceId), actor))
                .andExpect(status().isOk()).andReturn());
    }

    private ResultActions listRoomsAction(SessionResponse actor, UUID workspaceId)
            throws Exception {
        return mockMvc.perform(authed(
                get("/api/v1/workspaces/{workspaceId}/rooms", workspaceId), actor));
    }

    private ResultActions getRoom(SessionResponse actor, UUID roomId) throws Exception {
        return mockMvc.perform(authed(get("/api/v1/rooms/{roomId}", roomId), actor));
    }

    private ResultActions renameRoom(SessionResponse actor, UUID workspaceId, UUID roomId,
                                     String name) throws Exception {
        return patchRoom(actor, workspaceId, roomId, Map.of("name", name));
    }

    private ResultActions patchMediaMode(SessionResponse actor, UUID workspaceId, UUID roomId,
                                         String mediaMode) throws Exception {
        return patchRoom(actor, workspaceId, roomId, Map.of("media_mode", mediaMode));
    }

    private ResultActions patchRoom(SessionResponse actor, UUID workspaceId, UUID roomId,
                                    Map<String, Object> body) throws Exception {
        return mockMvc.perform(authed(patch(
                        "/api/v1/workspaces/{workspaceId}/rooms/{roomId}", workspaceId, roomId),
                        actor)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(body)));
    }

    private ResultActions closeRoom(SessionResponse actor, UUID workspaceId, UUID roomId)
            throws Exception {
        return mockMvc.perform(authed(delete(
                "/api/v1/workspaces/{workspaceId}/rooms/{roomId}", workspaceId, roomId), actor));
    }

    private ResultActions heartbeat(SessionResponse actor, UUID roomId) throws Exception {
        return mockMvc.perform(authed(
                post("/api/v1/rooms/{roomId}/presence", roomId), actor));
    }

    private ResultActions leave(SessionResponse actor, UUID roomId) throws Exception {
        return mockMvc.perform(authed(
                delete("/api/v1/rooms/{roomId}/presence", roomId), actor));
    }

    private ResultActions addMember(SessionResponse owner, UUID workspaceId, String email,
                                    String role) throws Exception {
        return mockMvc.perform(authed(
                        post("/api/v1/workspaces/{workspaceId}/members", workspaceId), owner)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(Map.of(
                        "email", email, "role", role))));
    }

    private SessionResponse scoped(SessionResponse user, UUID workspaceId) {
        IssuedToken token = tokenIssuer.issue(user.user().id(), user.device().id(), workspaceId);
        return new SessionResponse(token.accessToken(), token.expiresAt(), user.user(),
                user.device(), user.workspace(), user.chat());
    }

    private void setChatLimits(int perUser, int perWorkspace) {
        migrator().update("""
                UPDATE ops.system_settings
                   SET max_chats_per_user = ?, max_chats_per_workspace = ?
                 WHERE id = 1
                """, perUser, perWorkspace);
    }

    private Map<String, Object> roomRow(UUID roomId) {
        return migrator().queryForMap("""
                SELECT workspace_id, chat_id, name, created_by, status, media_mode
                  FROM room.rooms WHERE id = ?
                """, roomId);
    }

    private Map<String, Object> memberRow(UUID chatId, UUID userId) {
        List<Map<String, Object>> rows = migrator().queryForList("""
                SELECT role, status FROM chat.chat_members
                 WHERE chat_id = ? AND user_id = ?
                """, chatId, userId);
        return rows.isEmpty() ? Map.of() : rows.get(0);
    }

    private Map<String, Object> presenceRow(UUID roomId, UUID userId) {
        return migrator().queryForMap("""
                SELECT joined_at, last_seen_at FROM room.presence
                 WHERE room_id = ? AND user_id = ?
                """, roomId, userId);
    }

    private long roomCount(UUID workspaceId) {
        Long count = migrator().queryForObject(
                "SELECT count(*) FROM room.rooms WHERE workspace_id = ?",
                Long.class, workspaceId);
        return count == null ? 0 : count;
    }

    private long chatCount(UUID workspaceId) {
        Long count = migrator().queryForObject(
                "SELECT count(*) FROM chat.chats WHERE workspace_id = ? AND deleted_at IS NULL",
                Long.class, workspaceId);
        return count == null ? 0 : count;
    }

    private long presenceCount(UUID roomId) {
        Long count = migrator().queryForObject(
                "SELECT count(*) FROM room.presence WHERE room_id = ?", Long.class, roomId);
        return count == null ? 0 : count;
    }

    private String visibilityRow(UUID chatId) {
        return migrator().queryForObject(
                "SELECT visibility FROM chat.channel_settings WHERE chat_id = ?",
                String.class, chatId);
    }

    private String joinPolicy(UUID chatId) {
        return migrator().queryForObject(
                "SELECT join_policy FROM chat.chats WHERE id = ?", String.class, chatId);
    }

    private boolean chatCounterExists(UUID chatId) {
        Long count = migrator().queryForObject(
                "SELECT count(*) FROM chat.chat_counters WHERE chat_id = ?", Long.class, chatId);
        return count != null && count > 0;
    }

    private String chatName(UUID chatId) {
        return migrator().queryForObject(
                "SELECT name FROM chat.chats WHERE id = ?", String.class, chatId);
    }

    private Object chatDeletedAt(UUID chatId) {
        return migrator().queryForObject(
                "SELECT deleted_at FROM chat.chats WHERE id = ?", Object.class, chatId);
    }

    private String emailOf(UUID userId) {
        return migrator().queryForObject(
                "SELECT email::text FROM auth.users WHERE id = ?", String.class, userId);
    }

    private List<Map<String, Object>> mediaModeAudits(UUID roomId) {
        return migrator().queryForList("""
                SELECT actor_id, metadata::text AS metadata
                  FROM audit.audit_events
                 WHERE action = 'room.media_mode_changed' AND target_id = ?
                 ORDER BY seq
                """, roomId);
    }

    private void assertMediaModeAudit(Map<String, Object> audit, UUID actorId, String mode)
            throws Exception {
        assertThat(audit.get("actor_id")).isEqualTo(actorId);
        JsonNode metadata = objectMapper.readTree(String.valueOf(audit.get("metadata")));
        assertThat(metadata.fieldNames()).toIterable().containsExactly("media_mode");
        assertThat(metadata.get("media_mode").asText()).isEqualTo(mode);
    }
}
