package ru.krug.backend.plugin.api.dto;

import jakarta.validation.constraints.NotNull;

/** {@code PATCH /chats/{chatId}/polls/{pollId}} body; only {@code closed=true} is allowed. */
public record PollCloseRequest(@NotNull Boolean closed) {
}
