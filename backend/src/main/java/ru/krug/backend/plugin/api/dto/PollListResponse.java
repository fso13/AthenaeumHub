package ru.krug.backend.plugin.api.dto;

import java.util.List;

/** {@code GET /chats/{chatId}/polls}. */
public record PollListResponse(List<PollResponse> items) {
}
