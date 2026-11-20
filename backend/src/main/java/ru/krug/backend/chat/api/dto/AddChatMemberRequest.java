package ru.krug.backend.chat.api.dto;

import java.util.UUID;

import jakarta.validation.constraints.NotNull;

/** OpenAPI {@code AddChatMemberRequest} (#79). {@code role} absent means MEMBER. */
public record AddChatMemberRequest(@NotNull UUID userId, String role) {
}
