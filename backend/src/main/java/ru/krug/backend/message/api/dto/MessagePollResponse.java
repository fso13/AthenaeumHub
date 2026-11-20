package ru.krug.backend.message.api.dto;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import com.fasterxml.jackson.annotation.JsonInclude;

/** Poll embedded into a POLL message; field names match OpenAPI {@code Poll}. */
public record MessagePollResponse(UUID id, String question, List<MessagePollOptionResponse> options,
                                  UUID creatorId, boolean closed,
                                  @JsonInclude(JsonInclude.Include.NON_NULL) Instant closedAt,
                                  Instant createdAt,
                                  @JsonInclude(JsonInclude.Include.NON_NULL) UUID myOptionId,
                                  long totalVotes) {
}
