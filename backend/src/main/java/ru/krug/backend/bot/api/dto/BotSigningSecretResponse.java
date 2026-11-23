package ru.krug.backend.bot.api.dto;

/** One-time signing-secret reveal. The raw value is never retrievable again. */
public record BotSigningSecretResponse(BotResponse bot, String signingSecret) {
}
