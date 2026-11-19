package ru.krug.backend.realtime.application.model;

import java.util.List;
import java.util.UUID;

/**
 * Authorisation result for one call-signalling frame. A denial never reveals whether the
 * chat exists: {@code FORBIDDEN} covers missing membership and unknown chats alike.
 */
public record RealtimeCallAccess(boolean accepted, UUID workspaceId,
                                 List<UUID> memberUserIds, String reason) {

    public static final String FORBIDDEN = "FORBIDDEN";
    public static final String NOT_DIRECT = "NOT_DIRECT";

    public RealtimeCallAccess {
        memberUserIds = memberUserIds == null ? List.of() : List.copyOf(memberUserIds);
    }

    public static RealtimeCallAccess accepted(UUID workspaceId, List<UUID> memberUserIds) {
        return new RealtimeCallAccess(true, workspaceId, memberUserIds, null);
    }

    public static RealtimeCallAccess forbidden(UUID workspaceId) {
        return new RealtimeCallAccess(false, workspaceId, List.of(), FORBIDDEN);
    }

    public static RealtimeCallAccess notDirect(UUID workspaceId) {
        return new RealtimeCallAccess(false, workspaceId, List.of(), NOT_DIRECT);
    }
}
