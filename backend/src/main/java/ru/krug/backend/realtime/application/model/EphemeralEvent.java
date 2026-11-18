package ru.krug.backend.realtime.application.model;

import java.time.Instant;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;

/** Ephemeral event (typing/presence). Never persisted and never replayed. */
public record EphemeralEvent(
        String event,
        UUID workspaceId,
        UUID chatId,
        UUID userId,
        Instant ts,
        Map<String, Object> payload) {

    public EphemeralEvent {
        Objects.requireNonNull(event, "event");
        Objects.requireNonNull(workspaceId, "workspaceId");
        Objects.requireNonNull(chatId, "chatId");
        Objects.requireNonNull(userId, "userId");
        Objects.requireNonNull(ts, "ts");
        payload = java.util.Collections.unmodifiableMap(new java.util.LinkedHashMap<>(payload));
    }
}
