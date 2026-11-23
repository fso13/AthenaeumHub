package ru.krug.backend.bot.api.dto;

/** {@code POST /chats/{chatId}/commands} body. No chat message is created. */
public record BotCommandInvokeRequest(String command, String args) {
}
