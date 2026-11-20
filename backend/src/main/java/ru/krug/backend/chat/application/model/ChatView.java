package ru.krug.backend.chat.application.model;

import java.time.Instant;
import java.util.UUID;

public record ChatView(UUID id, String type, String securityMode, String visibility, UUID peerId,
                       boolean peerHasE2eeCapableDevices, String name, String description,
                       Integer keyEpoch, long lastSeq, long unreadCount, Instant createdAt) {
}
