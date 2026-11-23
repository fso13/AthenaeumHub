package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.time.Instant;
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
        assertThat(body.get("participant_count").asInt()).isZero();
        assertThat(body.get("my_present").asBoolean()).isFalse();
        assertThat(body.get("participants")).isEmpty();

        Map<String, Object> room = roomRow(roomId);
        assertThat(room.get("workspace_id")).isEqualTo(workspaceId);
        assertThat(room.get("chat_id")).isEqualTo(chatId);
        assertThat(room.get("name")).isEqualTo("Team Room");
        assertThat(room.get("created_by")).isEqualTo(creator.user().id());
        assertThat(room.get("status")).isEqualTo("ACTIVE");

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

    // ------------------------------------------------------------------

    private ResultActions createRoom(SessionResponse actor, UUID workspaceId, String name)
            throws Exception {
        return mockMvc.perform(authed(
                        post("/api/v1/workspaces/{workspaceId}/rooms", workspaceId), actor)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(Map.of("name", name))));
    }

    private JsonNode createRoomOk(SessionResponse actor, UUID workspaceId, String name)
            throws Exception {
        return json(createRoom(actor, workspaceId, name)
                .andExpect(status().isCreated()).andReturn());
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
        return mockMvc.perform(authed(patch(
                        "/api/v1/workspaces/{workspaceId}/rooms/{roomId}", workspaceId, roomId),
                        actor)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(Map.of("name", name))));
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
                SELECT workspace_id, chat_id, name, created_by, status
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
}
