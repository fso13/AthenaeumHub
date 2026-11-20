package ru.krug.backend.chat.application.model;

import java.time.Instant;
import java.util.UUID;

/** Pinned-message metadata returned by the pins API; never contains message content. */
public record ChatPinView(UUID chatId, UUID messageId, UUID pinnedBy, Instant pinnedAt) {
}
