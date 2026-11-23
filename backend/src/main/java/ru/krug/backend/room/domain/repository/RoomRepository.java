package ru.krug.backend.room.domain.repository;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import ru.krug.backend.room.domain.model.Room;
import ru.krug.backend.room.domain.model.RoomParticipant;
import ru.krug.backend.room.domain.model.RoomScope;

public interface RoomRepository {

    /** ACTIVE rooms of one workspace, newest first (hard-capped by the adapter). */
    List<Room> findActiveRooms(UUID workspaceId);

    /** Any room (ACTIVE or CLOSED) of one workspace; empty when missing/foreign. */
    Optional<Room> findById(UUID workspaceId, UUID roomId);

    /**
     * Resolves workspace/role/status before the workspace GUC is known. Empty when the
     * room does not exist or {@code userId} is not an ACTIVE workspace member.
     */
    Optional<RoomScope> findScope(UUID roomId, UUID userId);

    void save(Room room);

    /** @return {@code false} when the ACTIVE room disappeared concurrently */
    boolean rename(UUID workspaceId, UUID roomId, String name, Instant at);

    /**
     * #107 media-mode change; touches only {@code room.rooms.media_mode}/{@code updated_at}.
     *
     * @return {@code false} when the ACTIVE room disappeared concurrently
     */
    boolean changeMediaMode(UUID workspaceId, UUID roomId, Room.MediaMode mediaMode,
                            Instant at);

    /** Soft-close: status becomes CLOSED; the row and its history are retained. */
    boolean close(UUID workspaceId, UUID roomId, Instant at);

    /**
     * TTL-filtered participants of every ACTIVE room in the workspace. The query is a
     * narrow SECURITY DEFINER function that also verifies the viewer is an ACTIVE member.
     */
    List<RoomParticipant> findPresentParticipants(UUID workspaceId, UUID viewerId,
                                                   Instant cutoff);

    /**
     * Join/heartbeat upsert. {@code joinedAt} is preserved while the previous row is still
     * live and reset when the participant re-joins after the TTL.
     *
     * @return {@code false} when the room is closed or the membership is no longer ACTIVE
     */
    boolean touchPresence(UUID workspaceId, UUID roomId, UUID userId, Instant at,
                          Instant staleBefore);

    /** Idempotent leave: removes the row if present. */
    void removePresence(UUID roomId, UUID userId);

    /** Physical TTL cleanup; returns the number of removed stale rows. */
    int deleteStalePresence(Instant cutoff);
}
