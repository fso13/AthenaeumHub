package ru.krug.backend.room.infrastructure.persistence;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import jakarta.persistence.EntityManager;

import org.springframework.stereotype.Repository;

import ru.krug.backend.room.domain.model.Room;
import ru.krug.backend.room.domain.model.RoomParticipant;
import ru.krug.backend.room.domain.model.RoomScope;
import ru.krug.backend.room.domain.repository.RoomRepository;

/**
 * Native-SQL adapter for {@code room.rooms}/{@code room.presence}. RLS is enforced by the
 * tenant GUC; the SECURITY DEFINER functions are used only for the two deliberately narrow
 * cross-tenant lookups (scope resolution and TTL cleanup).
 */
@Repository
public class RoomRepositoryAdapter implements RoomRepository {

    /** Hard safety cap for the unpaginated room list (the UI has no pagination in #105). */
    private static final int MAX_ROOMS = 200;

    private final EntityManager entityManager;

    public RoomRepositoryAdapter(EntityManager entityManager) {
        this.entityManager = entityManager;
    }

    @Override
    public List<Room> findActiveRooms(UUID workspaceId) {
        @SuppressWarnings("unchecked")
        List<Object[]> rows = entityManager.createNativeQuery("""
                        SELECT id, workspace_id, chat_id, name, created_by, created_at,
                               updated_at, status, media_mode
                          FROM room.rooms
                         WHERE workspace_id = ?1
                           AND status = 'ACTIVE'
                         ORDER BY created_at DESC, id DESC
                         LIMIT ?2
                        """)
                .setParameter(1, workspaceId)
                .setParameter(2, MAX_ROOMS)
                .getResultList();
        return rows.stream().map(RoomRepositoryAdapter::toRoom).toList();
    }

    @Override
    public Optional<Room> findById(UUID workspaceId, UUID roomId) {
        @SuppressWarnings("unchecked")
        List<Object[]> rows = entityManager.createNativeQuery("""
                        SELECT id, workspace_id, chat_id, name, created_by, created_at,
                               updated_at, status, media_mode
                          FROM room.rooms
                         WHERE id = ?1 AND workspace_id = ?2
                        """)
                .setParameter(1, roomId)
                .setParameter(2, workspaceId)
                .getResultList();
        return rows.stream().findFirst().map(RoomRepositoryAdapter::toRoom);
    }

    @Override
    public Optional<RoomScope> findScope(UUID roomId, UUID userId) {
        @SuppressWarnings("unchecked")
        List<Object[]> rows = entityManager.createNativeQuery("""
                        SELECT workspace_id, workspace_role, room_status, created_by, chat_id
                          FROM room.room_scope(CAST(?1 AS uuid), CAST(?2 AS uuid))
                        """)
                .setParameter(1, roomId)
                .setParameter(2, userId)
                .getResultList();
        return rows.stream().findFirst().map(row -> new RoomScope(
                (UUID) row[0], (String) row[1], (String) row[2], (UUID) row[3],
                (UUID) row[4]));
    }

    @Override
    public void save(Room room) {
        entityManager.createNativeQuery("""
                        INSERT INTO room.rooms
                               (id, workspace_id, chat_id, name, created_by, created_at,
                                updated_at, status, media_mode)
                        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                        """)
                .setParameter(1, room.id())
                .setParameter(2, room.workspaceId())
                .setParameter(3, room.chatId())
                .setParameter(4, room.name())
                .setParameter(5, room.createdBy())
                .setParameter(6, Timestamp.from(room.createdAt()))
                .setParameter(7, Timestamp.from(room.updatedAt()))
                .setParameter(8, room.status().name())
                .setParameter(9, room.mediaMode().name())
                .executeUpdate();
    }

    @Override
    public boolean rename(UUID workspaceId, UUID roomId, String name, Instant at) {
        int updated = entityManager.createNativeQuery("""
                        UPDATE room.rooms
                           SET name = ?3, updated_at = ?4
                         WHERE id = ?1 AND workspace_id = ?2 AND status = 'ACTIVE'
                        """)
                .setParameter(1, roomId)
                .setParameter(2, workspaceId)
                .setParameter(3, name)
                .setParameter(4, Timestamp.from(at))
                .executeUpdate();
        return updated > 0;
    }

    @Override
    public boolean changeMediaMode(UUID workspaceId, UUID roomId, Room.MediaMode mediaMode,
                                   Instant at) {
        int updated = entityManager.createNativeQuery("""
                        UPDATE room.rooms
                           SET media_mode = ?3, updated_at = ?4
                         WHERE id = ?1 AND workspace_id = ?2 AND status = 'ACTIVE'
                        """)
                .setParameter(1, roomId)
                .setParameter(2, workspaceId)
                .setParameter(3, mediaMode.name())
                .setParameter(4, Timestamp.from(at))
                .executeUpdate();
        return updated > 0;
    }

    @Override
    public boolean close(UUID workspaceId, UUID roomId, Instant at) {
        int updated = entityManager.createNativeQuery("""
                        UPDATE room.rooms
                           SET status = 'CLOSED', updated_at = ?3
                         WHERE id = ?1 AND workspace_id = ?2
                        """)
                .setParameter(1, roomId)
                .setParameter(2, workspaceId)
                .setParameter(3, Timestamp.from(at))
                .executeUpdate();
        return updated > 0;
    }

    @Override
    public List<RoomParticipant> findPresentParticipants(UUID workspaceId, UUID viewerId,
                                                          Instant cutoff) {
        @SuppressWarnings("unchecked")
        List<Object[]> rows = entityManager.createNativeQuery("""
                        SELECT room_id, user_id, display_name, joined_at, last_seen_at
                          FROM room.presence_directory(CAST(?1 AS uuid), CAST(?2 AS uuid),
                                                       CAST(?3 AS timestamptz))
                        """)
                .setParameter(1, workspaceId)
                .setParameter(2, viewerId)
                .setParameter(3, Timestamp.from(cutoff))
                .getResultList();
        return rows.stream().map(row -> new RoomParticipant(
                (UUID) row[0],
                (UUID) row[1],
                (String) row[2],
                instant(row[3]),
                instant(row[4]))).toList();
    }

    @Override
    public boolean touchPresence(UUID workspaceId, UUID roomId, UUID userId, Instant at,
                                 Instant staleBefore) {
        int upserted = entityManager.createNativeQuery("""
                        INSERT INTO room.presence (room_id, user_id, joined_at, last_seen_at)
                        SELECT r.id, wm.user_id, CAST(?3 AS timestamptz),
                               CAST(?3 AS timestamptz)
                          FROM room.rooms r
                          JOIN workspace.memberships wm
                            ON wm.workspace_id = r.workspace_id
                           AND wm.user_id = ?2
                           AND wm.status = 'ACTIVE'
                          JOIN workspace.workspaces w
                            ON w.id = r.workspace_id
                           AND w.status = 'ACTIVE'
                         WHERE r.id = ?1
                           AND r.workspace_id = ?4
                           AND r.status = 'ACTIVE'
                        ON CONFLICT (room_id, user_id) DO UPDATE
                           SET last_seen_at = EXCLUDED.last_seen_at,
                               joined_at = CASE
                                   WHEN room.presence.last_seen_at
                                        < CAST(?5 AS timestamptz)
                                   THEN EXCLUDED.joined_at
                                   ELSE room.presence.joined_at
                               END
                        """)
                .setParameter(1, roomId)
                .setParameter(2, userId)
                .setParameter(3, Timestamp.from(at))
                .setParameter(4, workspaceId)
                .setParameter(5, Timestamp.from(staleBefore))
                .executeUpdate();
        return upserted > 0;
    }

    @Override
    public void removePresence(UUID roomId, UUID userId) {
        entityManager.createNativeQuery("""
                        DELETE FROM room.presence
                         WHERE room_id = ?1 AND user_id = ?2
                        """)
                .setParameter(1, roomId)
                .setParameter(2, userId)
                .executeUpdate();
    }

    @Override
    public int deleteStalePresence(Instant cutoff) {
        Number deleted = (Number) entityManager.createNativeQuery("""
                        SELECT room.presence_cleanup(CAST(?1 AS timestamptz))
                        """)
                .setParameter(1, Timestamp.from(cutoff))
                .getSingleResult();
        return deleted == null ? 0 : deleted.intValue();
    }

    private static Room toRoom(Object[] row) {
        return Room.reconstitute(
                (UUID) row[0],
                (UUID) row[1],
                (UUID) row[2],
                (String) row[3],
                Room.MediaMode.valueOf((String) row[8]),
                (UUID) row[4],
                instant(row[5]),
                instant(row[6]),
                Room.Status.valueOf((String) row[7]));
    }

    private static Instant instant(Object value) {
        if (value == null) {
            return null;
        }
        if (value instanceof Instant instant) {
            return instant;
        }
        if (value instanceof Timestamp timestamp) {
            return timestamp.toInstant();
        }
        if (value instanceof java.time.OffsetDateTime offsetDateTime) {
            return offsetDateTime.toInstant();
        }
        throw new IllegalStateException("Unsupported timestamp type: " + value.getClass());
    }
}
