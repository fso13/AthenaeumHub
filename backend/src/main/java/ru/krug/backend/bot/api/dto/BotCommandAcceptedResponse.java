package ru.krug.backend.bot.api.dto;

import java.util.UUID;

/** 202 acknowledgement: the signed {@code slash_command} delivery was queued. */
public record BotCommandAcceptedResponse(UUID deliveryId) {
}
