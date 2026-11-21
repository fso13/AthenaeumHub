package ru.krug.backend.bot.application.model;

/**
 * Create/rotate result: the bot metadata plus the raw bearer token. The raw value is present
 * exactly once in the response; it is not stored, not logged and not written to audit.
 */
public record IssuedBotToken(BotView bot, String token) {
}
