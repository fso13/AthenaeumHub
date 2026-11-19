package ru.krug.backend.realtime.application.model;

import java.util.Set;
import java.util.UUID;

/**
 * Authorisation result for one call-signalling frame. A denial never reveals whether the
 * chat exists: {@code FORBIDDEN} covers missing membership and unknown chats alike.
 *
 * <p>{@code chatType} is the resolved chat type ({@code DIRECT}/{@code GROUP}) and
 * {@code recipientUserIds} is the exact set of users this frame may be relayed to — the
 * single peer for DIRECT, or the validated subset requested by a GROUP conference frame.
 * It is deliberately not "all active chat members": a GROUP frame must never fan out to
 * users the caller did not name.
 */
public record RealtimeCallAccess(boolean accepted, UUID workspaceId, String chatType,
                                 Set<UUID> recipientUserIds, String reason) {

    public static final String FORBIDDEN = "FORBIDDEN";
    /** DIRECT with an ambiguous member set, or an unsupported chat type. */
    public static final String NOT_SUPPORTED = "NOT_SUPPORTED";
    /** DIRECT frame carried GROUP-only conference metadata. */
    public static final String CONFERENCE_NOT_ALLOWED = "CONFERENCE_NOT_ALLOWED";
    /** GROUP frame omitted conference metadata / recipients. */
    public static final String RECIPIENTS_REQUIRED = "RECIPIENTS_REQUIRED";

    public static final String DIRECT = "DIRECT";
    public static final String GROUP = "GROUP";

    public RealtimeCallAccess {
        recipientUserIds = recipientUserIds == null ? Set.of() : Set.copyOf(recipientUserIds);
    }

    public static RealtimeCallAccess accepted(UUID workspaceId, String chatType,
                                              Set<UUID> recipientUserIds) {
        return new RealtimeCallAccess(true, workspaceId, chatType, recipientUserIds, null);
    }

    public static RealtimeCallAccess forbidden(UUID workspaceId, String chatType) {
        return denied(workspaceId, chatType, FORBIDDEN);
    }

    public static RealtimeCallAccess notSupported(UUID workspaceId, String chatType) {
        return denied(workspaceId, chatType, NOT_SUPPORTED);
    }

    public static RealtimeCallAccess conferenceNotAllowed(UUID workspaceId, String chatType) {
        return denied(workspaceId, chatType, CONFERENCE_NOT_ALLOWED);
    }

    public static RealtimeCallAccess recipientsRequired(UUID workspaceId, String chatType) {
        return denied(workspaceId, chatType, RECIPIENTS_REQUIRED);
    }

    private static RealtimeCallAccess denied(UUID workspaceId, String chatType, String reason) {
        return new RealtimeCallAccess(false, workspaceId, chatType, Set.of(), reason);
    }
}
