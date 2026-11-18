package ru.krug.backend.auth.application.event;

import java.time.Instant;
import java.util.UUID;

/**
 * Application event: the owner's device list changed (registration / revoke / prekeys).
 * Delivered AFTER COMMIT to every live session of the user; metadata only.
 */
public record DeviceListChangedEvent(
        UUID workspaceId,
        UUID userId,
        UUID deviceId,
        String status,
        int keyGeneration,
        Instant occurredAt) {
}
