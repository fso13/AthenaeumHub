package ru.krug.backend.chat.api.dto;

import java.time.Instant;
import java.util.UUID;

/** One pinned message (metadata only; the message itself is fetched through the timeline). */
public record ChatPinResponse(UUID chatId, UUID messageId, UUID pinnedBy, Instant pinnedAt) {
}
