package ru.krug.backend.plugin.application.model;

import java.util.UUID;

/** Result of {@code POST /chats/{chatId}/polls}: the poll plus its timeline message. */
public record PollCreateResult(PollView poll, UUID messageId, boolean replay) {
}
