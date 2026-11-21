package ru.krug.backend.bot.api.dto;

import java.util.List;

/** Bots installed in a chat. */
public record ChatBotListResponse(List<ChatBotResponse> items) {
}
