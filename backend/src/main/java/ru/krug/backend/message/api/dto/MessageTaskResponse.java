package ru.krug.backend.message.api.dto;

import java.time.Instant;
import java.util.UUID;

import com.fasterxml.jackson.annotation.JsonInclude;

/** Task embedded into a TASK message; field names match OpenAPI {@code Task}. */
public record MessageTaskResponse(UUID id, String title, UUID creatorId,
                                  @JsonInclude(JsonInclude.Include.NON_NULL) UUID assigneeId,
                                  @JsonInclude(JsonInclude.Include.NON_NULL) Instant dueAt,
                                  boolean done,
                                  @JsonInclude(JsonInclude.Include.NON_NULL) UUID completedBy,
                                  @JsonInclude(JsonInclude.Include.NON_NULL) Instant completedAt,
                                  Instant createdAt) {
}
