package ru.krug.backend.auth.application.event;

import java.util.UUID;

/**
 * Application event: a device session must be closed proactively (E2EE-SPEC §5.4(1-2)).
 * The WS transport sends {@code session.revoked} and then closes with 4403.
 */
public record DeviceSessionRevokedEvent(UUID userId, UUID deviceId, String reason) {
}
