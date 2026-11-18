package ru.krug.backend.auth.application.event;

import java.util.UUID;

/**
 * Application event: every live session of a user must be closed proactively (E11-B
 * suspend). The WS transport sends {@code session.revoked} and closes with 4403. Unlike
 * {@link DeviceSessionRevokedEvent} this is not device-scoped and does not revoke E2EE
 * device keys — a suspension is reversible.
 */
public record UserSessionsRevokedEvent(UUID userId, String reason) {
}
