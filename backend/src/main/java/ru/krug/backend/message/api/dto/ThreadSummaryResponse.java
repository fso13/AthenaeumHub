package ru.krug.backend.message.api.dto;

import java.time.Instant;
import java.util.UUID;

/** OpenAPI inline {@code Message.thread_summary}. Nullable fields are serialized as null. */
public record ThreadSummaryResponse(
        long replyCount,
        Instant lastReplyAt,
        UUID lastReplyAuthorId,
        String lastReplyExcerpt) {
}
