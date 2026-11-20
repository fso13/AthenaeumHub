package ru.krug.backend.chat.api.dto;

import java.util.UUID;

import jakarta.validation.constraints.NotNull;

/** {@code POST /chats/{chatId}/pins} body (P0-2). */
public record ChatPinRequest(@NotNull UUID messageId) {
}
