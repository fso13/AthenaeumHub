package ru.krug.backend.chat.api.dto;

import java.util.List;

/** OpenAPI {@code ChatInviteList} (#79). */
public record ChatInviteListResponse(List<ChatInviteResponse> items) {
}
