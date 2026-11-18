package ru.krug.backend.chat.domain.model;

import java.time.Instant;
import java.util.UUID;

/**
 * Read model of the chat list, owned by the domain (state of a chat from the caller's view).
 * {@code peerId} is derived from chat_members and is null for GROUP; the capability flag
 * is derived from ACTIVE e2ee-capable devices and never exposes keys (D-S4-06).
 */
public record ChatSummary(
        UUID id,
        String name,
        Chat.Type type,
        Chat.SecurityMode securityMode,
        Instant lastMessageAt,
        long unreadCount,
        long lastSeq,
        UUID peerId,
        boolean peerHasE2eeCapableDevices,
        java.time.Instant createdAt) {
}
