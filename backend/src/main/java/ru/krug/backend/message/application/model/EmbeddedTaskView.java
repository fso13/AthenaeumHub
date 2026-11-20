package ru.krug.backend.message.application.model;

import java.time.Instant;
import java.util.UUID;

/** Current task state embedded into a TASK timeline message. */
public record EmbeddedTaskView(UUID id, String title, UUID creatorId, UUID assigneeId,
                               Instant dueAt, boolean done, UUID completedBy,
                               Instant completedAt, Instant createdAt) {
}
