package ru.krug.backend.auth.application.event;

import java.time.Instant;
import java.util.UUID;

/**
 * Application event: key material changed for one chat (E2EE-SPEC §6.3.1 C, §5.4).
 * Published in the write transaction and delivered to WS subscribers only AFTER COMMIT.
 * Carries metadata only — never key bytes or content. No {@code seq}: it is not replayable.
 */
public record DeviceKeyChangedEvent(
        UUID workspaceId,
        UUID chatId,
        String reason,
        UUID deviceId,
        Integer keyGeneration,
        Instant occurredAt) {

    public static final String DEVICE_ADDED = "DEVICE_ADDED";
    public static final String DEVICE_REVOKED = "DEVICE_REVOKED";
    public static final String IDENTITY_KEY_CHANGED = "IDENTITY_KEY_CHANGED";
    public static final String VERIFICATION_CHANGED = "VERIFICATION_CHANGED";
    public static final String KEY_GENERATION_CHANGED = "KEY_GENERATION_CHANGED";
}
