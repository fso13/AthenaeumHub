package ru.krug.backend.plugin.api.dto;

import java.util.List;

/** {@code GET /chats/{chatId}/tasks}. */
public record TaskListResponse(List<TaskResponse> items) {
}
