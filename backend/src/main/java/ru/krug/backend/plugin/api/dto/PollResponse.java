package ru.krug.backend.plugin.api.dto;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * {@code POST /chats/{chatId}/polls}, vote/close responses. {@code message_id} is present
 * only on the create response (#95); list/vote/close keep the previous shape.
 */
public record PollResponse(UUID id, String question, List<PollOptionResponse> options,
                           UUID creatorId, boolean closed, Instant closedAt,
                           Instant createdAt, UUID myOptionId, long totalVotes,
                           @JsonInclude(JsonInclude.Include.NON_NULL) UUID messageId) {
}
