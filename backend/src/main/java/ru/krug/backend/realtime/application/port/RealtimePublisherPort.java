package ru.krug.backend.realtime.application.port;

import java.time.Instant;
import java.util.UUID;

import ru.krug.backend.realtime.application.model.EphemeralEvent;
import ru.krug.backend.realtime.application.model.RealtimeEvent;

/**
 * Fan-out port. Durable events are delivered at-least-once; ephemeral events may be
 * dropped first when a connection is slow. Key-lifecycle events and session revocation are
 * metadata-only, never replayed, and carry no per-chat {@code seq}.
 */
public interface RealtimePublisherPort {

    void publish(RealtimeEvent event);

    void publishEphemeral(EphemeralEvent event, String excludeSessionId);

    /**
     * {@code chat.keys.changed} to every live subscriber of the chat. Not replayable.
     */
    void publishKeyChanged(UUID workspaceId, UUID chatId, String reason, UUID deviceId,
                           Integer keyGeneration, Instant occurredAt);

    /**
     * {@code device.list.changed} to every live session of the device owner.
     */
    void publishDeviceListChanged(UUID userId, UUID deviceId, String status, int keyGeneration,
                                  Instant occurredAt);

    /**
     * {@code session.revoked} followed by a 4403 close for every session of the device.
     */
    void publishSessionRevoked(UUID userId, UUID deviceId, String reason);

    /**
     * {@code session.revoked} followed by a 4403 close for every live session of the user
     * (E11-B suspend). Not replayable, no {@code seq}.
     */
    void publishUserSessionsRevoked(UUID userId, String reason);
}
