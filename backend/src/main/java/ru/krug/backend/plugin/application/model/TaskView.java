package ru.krug.backend.plugin.application.model;

import java.time.Instant;
import java.util.UUID;

import ru.krug.backend.plugin.domain.model.ChatTask;

/** API-facing task read model. */
public record TaskView(UUID id, String title, UUID creatorId, UUID assigneeId, Instant dueAt,
                       boolean done, UUID completedBy, Instant completedAt, Instant createdAt) {

    public static TaskView from(ChatTask task) {
        return new TaskView(task.id(), task.title(), task.creatorId(), task.assigneeId(),
                task.dueAt(), task.done(), task.completedBy(), task.completedAt(),
                task.createdAt());
    }
}
