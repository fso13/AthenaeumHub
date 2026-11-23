package ru.krug.backend.room.application.usecase;

import java.time.Instant;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.room.domain.model.Room;
import ru.krug.backend.room.domain.model.RoomPresencePolicy;
import ru.krug.backend.room.domain.model.RoomScope;
import ru.krug.backend.room.domain.repository.RoomRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.error.DomainException;

/**
 * Room presence (#105): {@code POST /rooms/{roomId}/presence} is the join/heartbeat upsert,
 * {@code DELETE /rooms/{roomId}/presence} is the idempotent leave.
 *
 * <p>Presence is deliberately REST-only: the frontend sends a heartbeat every 5 seconds and
 * every read filters on the 30-second TTL. No websocket frame, online flag or call state is
 * stored. A stale row (last_seen older than the TTL) is not returned; a subsequent heartbeat
 * resets {@code joined_at}, so "joined 2 hours ago" cannot leak from an old session.</p>
 */
@Service
public class RoomPresenceService {

    private final RoomAccessService access;
    private final RoomRepository rooms;
    private final ClockPort clock;

    public RoomPresenceService(RoomAccessService access, RoomRepository rooms,
                               ClockPort clock) {
        this.access = access;
        this.rooms = rooms;
        this.clock = clock;
    }

    @Transactional
    public void heartbeat(Principal principal, UUID roomId) {
        RoomScope scope = access.requireScope(principal, roomId);
        Room room = rooms.findById(scope.workspaceId(), roomId)
                .orElseThrow(() -> DomainException.notFound("Room not found"));
        room.requireActive();

        Instant now = clock.now();
        boolean touched = rooms.touchPresence(scope.workspaceId(), roomId,
                principal.userId(), now, RoomPresencePolicy.cutoff(now));
        if (!touched) {
            // The room was closed or the workspace membership was removed between the scope
            // read and the upsert. Do not disclose which one.
            throw DomainException.notFound("Room not found");
        }
    }

    @Transactional
    public void leave(Principal principal, UUID roomId) {
        RoomScope scope = access.requireScope(principal, roomId);
        rooms.findById(scope.workspaceId(), roomId)
                .orElseThrow(() -> DomainException.notFound("Room not found"));
        // A closed room may still be left; the delete is idempotent for a missing row.
        rooms.removePresence(roomId, principal.userId());
    }
}
