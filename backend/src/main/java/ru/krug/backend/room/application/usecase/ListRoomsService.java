package ru.krug.backend.room.application.usecase;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Collectors;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.room.application.model.RoomListView;
import ru.krug.backend.room.application.model.RoomView;
import ru.krug.backend.room.domain.model.Room;
import ru.krug.backend.room.domain.model.RoomParticipant;
import ru.krug.backend.room.domain.model.RoomPresencePolicy;
import ru.krug.backend.room.domain.repository.RoomRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.TenantContext;
import ru.krug.backend.workspace.application.port.WorkspaceAccessPort;

/**
 * {@code GET /workspaces/{workspaceId}/rooms} (#105). Returns ACTIVE rooms only and, for
 * every room, the participants whose heartbeat is inside the 30-second TTL. {@code my_present}
 * tells the frontend whether the caller is one of them; the frontend polls this endpoint
 * every 5 seconds, so no websocket presence is needed.
 */
@Service
public class ListRoomsService {

    private final TenantContext tenantContext;
    private final WorkspaceAccessPort workspaceAccess;
    private final RoomRepository rooms;
    private final ClockPort clock;

    public ListRoomsService(TenantContext tenantContext, WorkspaceAccessPort workspaceAccess,
                            RoomRepository rooms, ClockPort clock) {
        this.tenantContext = tenantContext;
        this.workspaceAccess = workspaceAccess;
        this.rooms = rooms;
        this.clock = clock;
    }

    @Transactional(readOnly = true)
    public RoomListView list(Principal principal, UUID workspaceId) {
        tenantContext.activate(principal.withWorkspace(workspaceId));
        workspaceAccess.requireActiveMember(workspaceId, principal.userId());

        Instant cutoff = RoomPresencePolicy.cutoff(clock.now());
        List<Room> activeRooms = rooms.findActiveRooms(workspaceId);
        Map<UUID, List<RoomParticipant>> present = rooms
                .findPresentParticipants(workspaceId, principal.userId(), cutoff)
                .stream()
                .collect(Collectors.groupingBy(RoomParticipant::roomId));
        List<RoomView> items = activeRooms.stream()
                .map(room -> RoomView.from(room,
                        present.getOrDefault(room.id(), List.of()), principal.userId()))
                .toList();
        return new RoomListView(items);
    }
}
