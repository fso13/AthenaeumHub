package ru.krug.backend.bot.api.dto;

import java.util.List;

/** Workspace bot list. Does not include credentials. */
public record BotListResponse(List<BotResponse> items) {
}
