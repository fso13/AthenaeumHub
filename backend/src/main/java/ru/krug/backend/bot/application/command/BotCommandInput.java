package ru.krug.backend.bot.application.command;

/** Raw slash-command registration from the API layer (validated by the bot domain). */
public record BotCommandInput(String command, String description) {
}
