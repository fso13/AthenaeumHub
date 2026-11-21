package ru.krug.backend.bot.api.dto;

import java.util.UUID;

/** {@code POST /bots/{botId}/messages}. The author is always the authenticated bot. */
public record BotMessageCreateRequest(UUID chatId, String text) {
}
