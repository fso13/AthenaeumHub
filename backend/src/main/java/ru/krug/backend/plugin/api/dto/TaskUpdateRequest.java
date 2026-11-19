package ru.krug.backend.plugin.api.dto;

import jakarta.validation.constraints.NotNull;

/** {@code PATCH /chats/{chatId}/tasks/{taskId}} body. */
public record TaskUpdateRequest(@NotNull Boolean done) {
}
