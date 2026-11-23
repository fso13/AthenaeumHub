package ru.krug.backend.bot.api.dto;

/** Registered slash command as returned by bot read/list operations. */
public record BotCommandResponse(String command, String description) {
}
