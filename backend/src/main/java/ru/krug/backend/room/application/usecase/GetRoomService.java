package ru.krug.backend.room.application.usecase;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.room.application.model.RoomView;
import ru.krug.backend.room.domain.model.Room;
import ru.krug.backend.room.domain.model.RoomParticipant;
import ru.krug.backend.room.domain.model.RoomPresencePolicy;
import ru.krug.backend.room.domain.model.RoomScope;
import ru.krug.backend.room.domain.repository.RoomRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.error.DomainException;

/**
 * {@code GET /rooms/{roomId}} (#105, optional detail). Any ACTIVE workspace member of the
 * room's workspace may read it; a CLOSED room is returned with {@code status=CLOSED} and an
 * empty live participant list, so the frontend can show the closed state.
 */
@Service
public class GetRoomService {

    private final RoomAccessService access;
    private final RoomRepository rooms;
    private final ClockPort clock;

    public GetRoomService(RoomAccessService access, RoomRepository rooms, ClockPort clock) {
        this.access = access;
        this.rooms = rooms;
        this.clock = clock;
    }

    @Transactional(readOnly = true)
    public RoomView get(Principal principal, UUID roomId) {
        RoomScope scope = access.requireScope(principal, roomId);
        Room room = rooms.findById(scope.workspaceId(), roomId)
                .orElseThrow(() -> DomainException.notFound("Room not found"));
        Instant cutoff = RoomPresencePolicy.cutoff(clock.now());
        List<RoomParticipant> participants = rooms
                .findPresentParticipants(scope.workspaceId(), principal.userId(), cutoff)
                .stream()
                .filter(participant -> participant.roomId().equals(roomId))
                .toList();
        return RoomView.from(room, participants, principal.userId());
    }
}
