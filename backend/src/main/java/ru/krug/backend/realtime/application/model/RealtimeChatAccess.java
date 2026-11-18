package ru.krug.backend.realtime.application.model;

import java.util.UUID;

/** Membership decision for one chat. A denied chat returns only {@code FORBIDDEN}. */
public record RealtimeChatAccess(boolean accepted, UUID workspaceId, long lastSeq,
                                 String reason) {

    public static RealtimeChatAccess accepted(UUID workspaceId, long lastSeq) {
        return new RealtimeChatAccess(true, workspaceId, lastSeq, null);
    }

    public static RealtimeChatAccess forbidden(UUID workspaceId) {
        return new RealtimeChatAccess(false, workspaceId, 0L, "FORBIDDEN");
    }
}
