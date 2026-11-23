package ru.krug.backend.room.application.usecase;

import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.audit.application.model.AuditRecord;
import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.chat.application.port.RoomChannelPort;
import ru.krug.backend.room.domain.model.Room;
import ru.krug.backend.room.domain.model.RoomScope;
import ru.krug.backend.room.domain.repository.RoomRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.error.DomainException;

/**
 * {@code DELETE /workspaces/{workspaceId}/rooms/{roomId}} (#105). Soft-close: the room row
 * becomes CLOSED and the backing channel is soft-deleted, so it disappears from both the
 * room list and the chat list while messages/blobs are retained. Allowed for the room
 * creator or a workspace OWNER (ADMIN alone cannot close somebody else's room). Repeating
 * the call is an idempotent 204 for an authorized actor.
 */
@Service
public class CloseRoomService {

    static final String ACTION = "room.closed";

    private final RoomAccessService access;
    private final RoomRepository rooms;
    private final RoomChannelPort channels;
    private final AuditPort audit;
    private final ClockPort clock;

    public CloseRoomService(RoomAccessService access, RoomRepository rooms,
                            RoomChannelPort channels, AuditPort audit, ClockPort clock) {
        this.access = access;
        this.rooms = rooms;
        this.channels = channels;
        this.audit = audit;
        this.clock = clock;
    }

    @Transactional
    public void close(Principal principal, UUID workspaceId, UUID roomId) {
        RoomScope scope = access.requireScope(principal, roomId);
        if (workspaceId == null || !workspaceId.equals(scope.workspaceId())) {
            throw DomainException.notFound("Room not found");
        }
        Room room = rooms.findById(workspaceId, roomId)
                .orElseThrow(() -> DomainException.notFound("Room not found"));
        if (!room.canBeClosedBy(principal.userId(), scope.workspaceRole())) {
            throw DomainException.forbidden("Only the room creator or a workspace OWNER"
                    + " can close the room");
        }
        if (room.status() == Room.Status.CLOSED) {
            return;
        }

        var now = clock.now();
        if (!rooms.close(workspaceId, roomId, now)) {
            throw DomainException.notFound("Room not found");
        }
        channels.closeBackingChannel(principal, workspaceId, room.chatId());
        audit.append(new AuditRecord(workspaceId, principal.userId(), ACTION, "room", roomId,
                principal.requestId(),
                Map.of("chat_id", room.chatId().toString(), "status", "CLOSED"), now));
    }
}
