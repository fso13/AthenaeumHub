package ru.krug.backend.room.application.usecase;

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
import ru.krug.backend.room.domain.repository.RoomRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.TenantContext;
import ru.krug.backend.workspace.application.port.WorkspaceAccessPort;

/**
 * {@code POST /workspaces/{workspaceId}/rooms} (#105). Any ACTIVE workspace member may
 * create a room. The backing managed PUBLIC GROUP channel is created first (creator OWNER,
 * every ACTIVE workspace member, OPEN join policy) and then linked from {@code room.rooms}
 * in the same transaction. Installation chat limits apply, so a room consumes one chat slot.
 */
@Service
public class CreateRoomService {

    static final String ACTION = "room.created";

    private final TenantContext tenantContext;
    private final WorkspaceAccessPort workspaceAccess;
    private final RoomRepository rooms;
    private final RoomChannelPort channels;
    private final AuditPort audit;
    private final ClockPort clock;

    public CreateRoomService(TenantContext tenantContext, WorkspaceAccessPort workspaceAccess,
                             RoomRepository rooms, RoomChannelPort channels, AuditPort audit,
                             ClockPort clock) {
        this.tenantContext = tenantContext;
        this.workspaceAccess = workspaceAccess;
        this.rooms = rooms;
        this.channels = channels;
        this.audit = audit;
        this.clock = clock;
    }

    @Transactional
    public RoomView create(Principal principal, UUID workspaceId, String name,
                           String mediaMode) {
        tenantContext.activate(principal.withWorkspace(workspaceId));
        workspaceAccess.requireActiveMember(workspaceId, principal.userId());

        String normalized = Room.normalizeName(name);
        Room.MediaMode mode = Room.MediaMode.defaulted(mediaMode);
        UUID chatId = channels.createBackingChannel(principal, workspaceId, normalized);
        Room room = Room.create(UUID.randomUUID(), workspaceId, chatId, normalized, mode,
                principal.userId(), clock.now());
        rooms.save(room);

        audit.append(new AuditRecord(workspaceId, principal.userId(), ACTION, "room",
                room.id(), principal.requestId(),
                Map.of("chat_id", chatId.toString(), "status", room.status().name()),
                clock.now()));
        return RoomView.from(room, List.of(), principal.userId());
    }
}
