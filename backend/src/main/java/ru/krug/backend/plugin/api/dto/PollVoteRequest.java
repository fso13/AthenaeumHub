package ru.krug.backend.plugin.api.dto;

import java.util.UUID;

import jakarta.validation.constraints.NotNull;

/** {@code POST /chats/{chatId}/polls/{pollId}/votes} body. */
public record PollVoteRequest(@NotNull UUID optionId) {
}
