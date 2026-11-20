package ru.krug.backend.chat.api.dto;

import java.util.List;

/** {@code GET /chats/{chatId}/pins}: newest pin first. */
public record ChatPinListResponse(List<ChatPinResponse> items) {
}
