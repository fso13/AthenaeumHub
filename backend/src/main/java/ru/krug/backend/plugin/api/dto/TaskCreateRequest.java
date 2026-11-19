package ru.krug.backend.plugin.api.dto;

import java.time.Instant;
import java.util.UUID;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/** {@code POST /chats/{chatId}/tasks} body. */
public record TaskCreateRequest(
        @NotBlank @Size(max = 500) String title,
        UUID assigneeId,
        Instant dueAt) {
}
