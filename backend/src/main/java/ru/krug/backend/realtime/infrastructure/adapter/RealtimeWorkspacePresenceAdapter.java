package ru.krug.backend.realtime.infrastructure.adapter;

import java.util.UUID;

import org.springframework.stereotype.Component;

import ru.krug.backend.realtime.infrastructure.ws.InMemoryRealtimeHub;
import ru.krug.backend.workspace.application.port.WorkspacePresencePort;

/**
 * Presence adapter for the workspace overview. Counts distinct user ids with a live WS
 * connection bound to the workspace. The hub is single-node and in-process, so the value is
 * a live best-effort signal (documented in the contract) and never persisted.
 */
@Component
public class RealtimeWorkspacePresenceAdapter implements WorkspacePresencePort {

    private final InMemoryRealtimeHub hub;

    public RealtimeWorkspacePresenceAdapter(InMemoryRealtimeHub hub) {
        this.hub = hub;
    }

    @Override
    public int onlineMemberCount(UUID workspaceId) {
        return workspaceId == null ? 0 : hub.onlineMemberCount(workspaceId);
    }
}
