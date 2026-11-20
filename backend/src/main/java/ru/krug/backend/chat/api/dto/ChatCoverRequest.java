package ru.krug.backend.chat.api.dto;

import java.util.UUID;

import jakarta.validation.constraints.NotNull;

/**
 * {@code POST /chats/{chatId}/cover} body (P0-2): an existing CLEAN image attachment of this
 * chat. There is no new upload pipeline; the client uploads through the regular file flow and
 * then references the resulting attachment id.
 */
public record ChatCoverRequest(@NotNull UUID fileId) {
}
