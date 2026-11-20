package ru.krug.backend.plugin.api.dto;

import java.time.Instant;
import java.util.UUID;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * {@code Task} response. {@code message_id} is present only on the create response (#95).
 */
public record TaskResponse(UUID id, String title, UUID creatorId, UUID assigneeId,
                           Instant dueAt, boolean done, UUID completedBy,
                           Instant completedAt, Instant createdAt,
                           @JsonInclude(JsonInclude.Include.NON_NULL) UUID messageId) {
}
