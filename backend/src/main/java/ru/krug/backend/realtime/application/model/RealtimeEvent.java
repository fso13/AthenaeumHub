package ru.krug.backend.realtime.application.model;

import java.time.Instant;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;

/**
 * Durable realtime event. {@code eventId} is stable per domain fact (message id for
 * message.created), so a reconnect/replay never creates a different identity for the same
 * message. Payload values use the OpenAPI snake_case field names.
 *
 * <p>{@code cryptoByDevice} is an in-process delivery hint only: it lets the transport put
 * the envelope of the connection's device into that connection's frame without ever
 * serialising another device's envelope. It is never written to the outbox and never
 * appears in the wire frame as a map.
 */
public record RealtimeEvent(
        UUID eventId,
        String event,
        UUID workspaceId,
        UUID chatId,
        long seq,
        Instant ts,
        Map<String, Object> payload,
        Map<UUID, Object> cryptoByDevice) {

    public RealtimeEvent {
        Objects.requireNonNull(eventId, "eventId");
        Objects.requireNonNull(event, "event");
        Objects.requireNonNull(workspaceId, "workspaceId");
        Objects.requireNonNull(chatId, "chatId");
        if (seq < 0) {
            throw new IllegalArgumentException("seq must be >= 0");
        }
        Objects.requireNonNull(ts, "ts");
        payload = java.util.Collections.unmodifiableMap(new java.util.LinkedHashMap<>(payload));
        cryptoByDevice = cryptoByDevice == null ? Map.of() : Map.copyOf(cryptoByDevice);
    }

    public RealtimeEvent(UUID eventId, String event, UUID workspaceId, UUID chatId, long seq,
                         Instant ts, Map<String, Object> payload) {
        this(eventId, event, workspaceId, chatId, seq, ts, payload, Map.of());
    }
}
