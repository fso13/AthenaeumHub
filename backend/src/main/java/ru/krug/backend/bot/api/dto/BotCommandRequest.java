package ru.krug.backend.bot.api.dto;

/** Slash-command registration item: {@code command} is lowercase 1..32, unique per bot. */
public record BotCommandRequest(String command, String description) {
}
