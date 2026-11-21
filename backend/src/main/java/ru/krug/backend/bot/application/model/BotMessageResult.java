package ru.krug.backend.bot.application.model;

import ru.krug.backend.message.application.model.MessageView;

/** Result of a bot send: the created/replayed message and whether it was an idempotent replay. */
public record BotMessageResult(MessageView message, boolean replay) {
}
