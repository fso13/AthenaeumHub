package ru.krug.backend.chat.domain.model;

import java.time.Instant;
import java.util.UUID;

/**
 * Read model of the chat list, owned by the domain (state of a chat from the caller's view).
 * {@code peerId} is derived from chat_members and is null for GROUP; the capability flag
 * is derived from ACTIVE e2ee-capable devices and never exposes keys (D-S4-06).
 *
 * <p>P0-2 additive fields: {@code coverFileId}, {@code avatarFileId}, {@code readOnly},
 * {@code joinPolicy} (null for DIRECT) and {@code archived} (the caller's own archive state,
 * never another user's).</p>
 *
 * <p>#99 additive field: {@code memberCount} is the exact number of ACTIVE chat members
 * (also bounded by an ACTIVE workspace membership), never the workspace member count. A
 * DIRECT chat is 2 while both participants remain in the workspace; after a participant
 * leaves, their participant row is REMOVED and the count reflects the remaining member.</p>
 */
public record ChatSummary(
        UUID id,
        String name,
        String description,
        Chat.Type type,
        Chat.SecurityMode securityMode,
        ChannelVisibility visibility,
        Instant lastMessageAt,
        long unreadCount,
        long lastSeq,
        UUID peerId,
        boolean peerHasE2eeCapableDevices,
        java.time.Instant createdAt,
        UUID coverFileId,
        UUID avatarFileId,
        boolean readOnly,
        ChannelJoinPolicy joinPolicy,
        boolean archived,
        int memberCount) {
}
