package ru.krug.backend.plugin.api.dto;

import java.time.Instant;
import java.util.UUID;

/** {@code Task} response. */
public record TaskResponse(UUID id, String title, UUID creatorId, UUID assigneeId,
                           Instant dueAt, boolean done, UUID completedBy,
                           Instant completedAt, Instant createdAt) {
}
