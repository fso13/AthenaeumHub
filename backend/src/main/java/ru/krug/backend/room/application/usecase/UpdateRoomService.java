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
 * {@code PATCH /workspaces/{workspaceId}/rooms/{roomId}} (#105/#107). Partial update of the
 * room name and/or {@code media_mode}; at least one field is required.
 *
 * <p>A rename also renames the backing channel. A media-mode change is metadata-only: the
 * backing channel, message history, attachments and the existing call signalling are
 * untouched (the frontend simply requests audio or video next time). Allowed for the room
 * creator or a workspace OWNER/ADMIN; a plain member cannot edit somebody else's room. A
 * CLOSED room cannot be edited.</p>
 */
@Service
public class UpdateRoomService {

    static final String RENAMED_ACTION = "room.renamed";
    static final String MEDIA_MODE_ACTION = "room.media_mode_changed";

    private final RoomAccessService access;
    private final RoomRepository rooms;
    private final RoomChannelPort channels;
    private final AuditPort audit;
    private final ClockPort clock;

    public UpdateRoomService(RoomAccessService access, RoomRepository rooms,
                             RoomChannelPort channels, AuditPort audit, ClockPort clock) {
        this.access = access;
        this.rooms = rooms;
        this.channels = channels;
        this.audit = audit;
        this.clock = clock;
    }

    @Transactional
    public RoomView update(Principal principal, UUID workspaceId, UUID roomId, String name,
                           String mediaMode) {
        RoomScope scope = access.requireScope(principal, roomId);
        requireSameWorkspace(scope, workspaceId);
        Room room = rooms.findById(workspaceId, roomId)
                .orElseThrow(() -> DomainException.notFound("Room not found"));
        room.requireActive();
        if (!room.canBeEditedBy(principal.userId(), scope.workspaceRole())) {
            throw DomainException.forbidden("Only the room creator or a workspace OWNER/ADMIN"
                    + " can edit the room");
        }
        if (name == null && mediaMode == null) {
            throw DomainException.badRequest("name or media_mode must be provided",
                    Map.of("fields", List.of("name", "media_mode")));
        }

        String normalizedName = name == null ? null : Room.normalizeName(name);
        Room.MediaMode newMode = mediaMode == null ? null : Room.MediaMode.parse(mediaMode);
        Instant now = clock.now();
        Room updated = room;
        boolean renamed = normalizedName != null && !normalizedName.equals(room.name());
        if (renamed) {
            if (!rooms.rename(workspaceId, roomId, normalizedName, now)) {
                throw DomainException.notFound("Room not found");
            }
            channels.renameBackingChannel(principal, workspaceId, room.chatId(), normalizedName);
            updated = updated.rename(normalizedName, now);
            audit.append(new AuditRecord(workspaceId, principal.userId(), RENAMED_ACTION,
                    "room", roomId, principal.requestId(),
                    Map.of("chat_id", room.chatId().toString()), now));
        }
        if (newMode != null && newMode != room.mediaMode()) {
            if (!rooms.changeMediaMode(workspaceId, roomId, newMode, now)) {
                throw DomainException.notFound("Room not found");
            }
            updated = updated.changeMediaMode(newMode, now);
            // Metadata only: no name, participant, channel or content data.
            audit.append(new AuditRecord(workspaceId, principal.userId(), MEDIA_MODE_ACTION,
                    "room", roomId, principal.requestId(),
                    Map.of("media_mode", newMode.name()), now));
        }

        List<RoomParticipant> participants = rooms.findPresentParticipants(workspaceId,
                principal.userId(), RoomPresencePolicy.cutoff(now)).stream()
                .filter(participant -> participant.roomId().equals(roomId))
                .toList();
        return RoomView.from(updated, participants, principal.userId());
    }

    private static void requireSameWorkspace(RoomScope scope, UUID workspaceId) {
        if (workspaceId == null || !workspaceId.equals(scope.workspaceId())) {
            // A room from another workspace must not be distinguishable from a missing one.
            throw DomainException.notFound("Room not found");
        }
    }
}
