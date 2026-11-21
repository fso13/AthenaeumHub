package ru.krug.backend.bot.api.dto;

import java.util.UUID;

/** {@code POST /chats/{chatId}/bots}. Installation is idempotent. */
public record ChatBotInstallRequest(UUID botId) {
}
