package ru.krug.backend.room.application.usecase;

import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.room.domain.model.RoomScope;
import ru.krug.backend.room.domain.repository.RoomRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.TenantContext;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.workspace.application.port.WorkspaceAccessPort;

/**
 * Binds a room-scoped request (URL has no workspaceId) to the room's workspace, then
 * activates the tenant RLS context. The first lookup runs the narrow SECURITY DEFINER
 * {@code room.room_scope(room_id, user_id)} with only the user GUC; unknown rooms and
 * foreign rooms are indistinguishable (404).
 */
@Service
public class RoomAccessService {

    private final TenantContext tenantContext;
    private final RoomRepository rooms;
    private final WorkspaceAccessPort workspaceAccess;

    public RoomAccessService(TenantContext tenantContext, RoomRepository rooms,
                             WorkspaceAccessPort workspaceAccess) {
        this.tenantContext = tenantContext;
        this.rooms = rooms;
        this.workspaceAccess = workspaceAccess;
    }

    @Transactional(readOnly = true)
    public RoomScope requireScope(Principal principal, UUID roomId) {
        tenantContext.activate(new Principal(principal.userId(), principal.deviceId(), null,
                principal.requestId(), principal.sessionId()));
        RoomScope scope = rooms.findScope(roomId, principal.userId())
                .orElseThrow(() -> DomainException.notFound("Room not found"));
        tenantContext.activate(principal.withWorkspace(scope.workspaceId()));
        workspaceAccess.requireActiveMember(scope.workspaceId(), principal.userId());
        return scope;
    }
}
