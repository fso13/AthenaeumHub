package ru.krug.backend.bot.api.dto;

import java.util.List;

/** Recent deliveries for one bot, newest first. */
public record BotDeliveryListResponse(List<BotDeliveryResponse> items) {
}
