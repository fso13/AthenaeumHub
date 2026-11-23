package ru.krug.backend.bot.api.dto;

import java.util.UUID;

/** 202 acknowledgement for a queued test event or slash-command delivery. */
public record BotDeliveryAcceptedResponse(UUID deliveryId) {
}
