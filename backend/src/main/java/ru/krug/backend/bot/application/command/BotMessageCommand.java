package ru.krug.backend.bot.application.command;

import java.util.UUID;

/** {@code POST /bots/{botId}/messages} body. The bot identity comes only from the token. */
public record BotMessageCommand(UUID chatId, String text, String idempotencyKey) {
}
