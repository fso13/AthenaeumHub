package ru.krug.backend.bot.application.model;

import java.time.Instant;
import java.util.UUID;

/**
 * Installation projection. The embedded bot view lets the client render the bot name/avatar
 * in the chat settings without a second request.
 */
public record ChatBotView(UUID chatId, BotView bot, boolean enabled, Instant installedAt) {
}
