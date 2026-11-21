package ru.krug.backend.bot.api.dto;

import java.time.Instant;
import java.util.UUID;

/** Installed bot in a chat; the embedded bot metadata has no credential. */
public record ChatBotResponse(UUID chatId, BotResponse bot, boolean enabled,
                              Instant installedAt) {
}
