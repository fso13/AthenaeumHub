package ru.krug.backend.room.application.usecase;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.audit.application.model.AuditRecord;
import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.chat.application.port.RoomChannelPort;
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
 * {@code PATCH /workspaces/{workspaceId}/rooms/{roomId}} (#105). Renames the room and the
 * backing channel. Allowed for the room creator or a workspace OWNER/ADMIN; a plain member
 * cannot rename somebody else's room. A CLOSED room cannot be renamed.
 */
@Service
public class RenameRoomService {

    static final String ACTION = "room.renamed";

    private final RoomAccessService access;
    private final RoomRepository rooms;
    private final RoomChannelPort channels;
    private final AuditPort audit;
    private final ClockPort clock;

    public RenameRoomService(RoomAccessService access, RoomRepository rooms,
                             RoomChannelPort channels, AuditPort audit, ClockPort clock) {
        this.access = access;
        this.rooms = rooms;
        this.channels = channels;
        this.audit = audit;
        this.clock = clock;
    }

    @Transactional
    public RoomView rename(Principal principal, UUID workspaceId, UUID roomId, String name) {
        RoomScope scope = access.requireScope(principal, roomId);
        requireSameWorkspace(scope, workspaceId);
        Room room = rooms.findById(workspaceId, roomId)
                .orElseThrow(() -> DomainException.notFound("Room not found"));
        room.requireActive();
        if (!room.canBeEditedBy(principal.userId(), scope.workspaceRole())) {
            throw DomainException.forbidden("Only the room creator or a workspace OWNER/ADMIN"
                    + " can rename the room");
        }

        String normalized = Room.normalizeName(name);
        Instant now = clock.now();
        if (!rooms.rename(workspaceId, roomId, normalized, now)) {
            throw DomainException.notFound("Room not found");
        }
        channels.renameBackingChannel(principal, workspaceId, room.chatId(), normalized);
        Room renamed = Room.reconstitute(room.id(), room.workspaceId(), room.chatId(),
                normalized, room.createdBy(), room.createdAt(), now, room.status());

        audit.append(new AuditRecord(workspaceId, principal.userId(), ACTION, "room", roomId,
                principal.requestId(), Map.of("chat_id", room.chatId().toString()), now));
        List<RoomParticipant> participants = rooms.findPresentParticipants(workspaceId,
                principal.userId(), RoomPresencePolicy.cutoff(now)).stream()
                .filter(participant -> participant.roomId().equals(roomId))
                .toList();
        return RoomView.from(renamed, participants, principal.userId());
    }

    private static void requireSameWorkspace(RoomScope scope, UUID workspaceId) {
        if (workspaceId == null || !workspaceId.equals(scope.workspaceId())) {
            // A room from another workspace must not be distinguishable from a missing one.
            throw DomainException.notFound("Room not found");
        }
    }
}
