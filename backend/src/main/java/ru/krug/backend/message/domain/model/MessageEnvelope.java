package ru.krug.backend.message.domain.model;

import java.time.Instant;
import java.util.Objects;
import java.util.UUID;

/**
 * Persisted envelope row: one message, one recipient device, one shared {@code createdAt}
 * (the row's partition key). Envelopes are opaque: only the recipient device may read one
 * back (E2EE-SPEC §4.3).
 */
public record MessageEnvelope(UUID messageId, UUID workspaceId, UUID chatId,
                              Instant createdAt, CryptoEnvelope envelope) {

    public MessageEnvelope {
        Objects.requireNonNull(messageId, "messageId");
        Objects.requireNonNull(workspaceId, "workspaceId");
        Objects.requireNonNull(chatId, "chatId");
        Objects.requireNonNull(createdAt, "createdAt");
        Objects.requireNonNull(envelope, "envelope");
    }

    public UUID recipientDeviceId() {
        return envelope.recipientDeviceId();
    }
}
