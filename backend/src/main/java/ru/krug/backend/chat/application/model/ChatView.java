package ru.krug.backend.chat.application.model;

import java.time.Instant;
import java.util.UUID;

public record ChatView(UUID id, String type, String securityMode, UUID peerId,
                       boolean peerHasE2eeCapableDevices, String name, Integer keyEpoch,
                       long lastSeq, long unreadCount, Instant createdAt) {
}
