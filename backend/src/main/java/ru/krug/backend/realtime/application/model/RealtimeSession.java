package ru.krug.backend.realtime.application.model;

import java.time.Instant;
import java.util.Objects;
import java.util.UUID;

/** Authenticated WS session created after consuming a one-time ticket. */
public record RealtimeSession(
        String sessionId,
        UUID userId,
        UUID deviceId,
        UUID workspaceId,
        Instant connectedAt) {

    /** Request attribute set by the handshake interceptor. */
    public static final String ATTRIBUTE = RealtimeSession.class.getName();

    public RealtimeSession {
        if (sessionId == null || sessionId.isBlank()) {
            throw new IllegalArgumentException("sessionId is required");
        }
        Objects.requireNonNull(userId, "userId");
        Objects.requireNonNull(deviceId, "deviceId");
        Objects.requireNonNull(connectedAt, "connectedAt");
    }

    public static RealtimeSession open(UUID userId, UUID deviceId, UUID workspaceId,
                                       Instant connectedAt) {
        return new RealtimeSession("ws_" + UUID.randomUUID(), userId, deviceId, workspaceId,
                connectedAt);
    }
}
