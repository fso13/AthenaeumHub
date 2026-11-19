package ru.krug.backend.plugin.api.dto;

import java.util.List;

/** {@code GET /chats/{chatId}/plugins} response. */
public record ChatPluginStateListResponse(List<ChatPluginStateResponse> items) {
}
