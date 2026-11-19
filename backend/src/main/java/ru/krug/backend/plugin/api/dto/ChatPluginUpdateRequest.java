package ru.krug.backend.plugin.api.dto;

import jakarta.validation.constraints.NotNull;

/** {@code PATCH /chats/{chatId}/plugins/{pluginId}} body. */
public record ChatPluginUpdateRequest(@NotNull Boolean enabled) {
}
