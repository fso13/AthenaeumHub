package ru.krug.backend.chat.api.dto;

import java.util.UUID;

import jakarta.validation.constraints.NotNull;

/**
 * {@code POST /chats/{chatId}/avatar} body: an existing CLEAN/SKIPPED image attachment of
 * this chat. There is no new upload pipeline; the client uploads through the regular file flow
 * and then references the resulting attachment id.
 */
public record ChatAvatarRequest(@NotNull UUID fileId) {
}
