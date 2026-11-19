package ru.krug.backend.plugin.api.dto;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/** {@code POST /chats/{chatId}/polls}, vote/close responses. */
public record PollResponse(UUID id, String question, List<PollOptionResponse> options,
                           UUID creatorId, boolean closed, Instant closedAt,
                           Instant createdAt, UUID myOptionId, long totalVotes) {
}
