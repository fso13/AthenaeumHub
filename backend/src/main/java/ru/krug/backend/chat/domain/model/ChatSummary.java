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
        boolean archived) {
}
