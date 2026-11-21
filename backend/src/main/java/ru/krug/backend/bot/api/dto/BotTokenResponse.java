package ru.krug.backend.bot.api.dto;

/**
 * Create/rotate response: the bot plus the raw one-time token. The token is returned exactly
 * once and is never readable again.
 */
public record BotTokenResponse(BotResponse bot, String token) {
}
