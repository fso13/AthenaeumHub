package ru.krug.backend.plugin.application.model;

import java.util.UUID;

/** Result of {@code POST /chats/{chatId}/tasks}: the task plus its timeline message. */
public record TaskCreateResult(TaskView task, UUID messageId, boolean replay) {
}
