package ru.krug.backend.message.application.event;

import java.util.Map;
import java.util.UUID;

import ru.krug.backend.message.application.model.MessageView;

/**
 * In-process signal that a message committed. {@code cryptoByDevice} carries the opaque
 * envelope of every recipient device so the realtime listener can build a per-device
 * {@code message.created} payload after commit; it is never persisted, logged or exposed to
 * any other device.
 */
public record MessageCreatedNotification(UUID workspaceId, MessageView message,
                                        Map<UUID, Object> cryptoByDevice) {

    public MessageCreatedNotification {
        cryptoByDevice = cryptoByDevice == null ? Map.of() : Map.copyOf(cryptoByDevice);
    }

    public MessageCreatedNotification(UUID workspaceId, MessageView message) {
        this(workspaceId, message, Map.of());
    }
}
