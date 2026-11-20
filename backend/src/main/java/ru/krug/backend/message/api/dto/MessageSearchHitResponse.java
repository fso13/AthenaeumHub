package ru.krug.backend.message.api.dto;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * OpenAPI {@code MessageSearchHit}. {@code snippet} is plain text of a MANAGED message;
 * clients must render it as text and use {@code highlights} as emphasis ranges, never inject
 * it as HTML.
 */
public record MessageSearchHitResponse(
        UUID messageId,
        UUID chatId,
        String chatName,
        long seq,
        UUID senderId,
        String senderDisplayName,
        String snippet,
        List<SearchHighlightResponse> highlights,
        Instant createdAt) {
}
