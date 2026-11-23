package ru.krug.backend.bot.api.dto;

/** {@code POST /bot-responses/{token}} body: the one reply the capability authorises. */
public record BotResponseCreateRequest(String text) {
}
