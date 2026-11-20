package ru.krug.backend.chat.domain.model;

import java.time.Instant;
import java.util.Objects;
import java.util.UUID;

/**
 * Pinned-message metadata for a GROUP channel (P0-2 / #80, ENT-20). The message body is not
 * copied here and no E2EE plaintext/metadata is ever stored: only the ids and the time.
 */
public record ChatPin(UUID chatId, UUID messageId, UUID pinnedBy, Instant pinnedAt) {

    public ChatPin {
        Objects.requireNonNull(chatId, "chatId");
        Objects.requireNonNull(messageId, "messageId");
        Objects.requireNonNull(pinnedBy, "pinnedBy");
        Objects.requireNonNull(pinnedAt, "pinnedAt");
    }
}
