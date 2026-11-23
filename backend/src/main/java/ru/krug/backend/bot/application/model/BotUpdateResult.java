package ru.krug.backend.bot.application.model;

/**
 * Result of a PATCH. {@code signingSecret} is non-null only when this call generated the
 * secret for a newly configured event endpoint; it must be shown once and never stored.
 */
public record BotUpdateResult(BotView bot, String signingSecret) {
}
