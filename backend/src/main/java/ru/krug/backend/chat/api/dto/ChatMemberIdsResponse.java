package ru.krug.backend.chat.api.dto;

import java.util.List;
import java.util.UUID;

/**
 * OpenAPI {@code ChatMemberIds} (#79): detailed ACTIVE members plus the legacy flat id
 * projection used by the group-call participant picker.
 */
public record ChatMemberIdsResponse(List<UUID> userIds, List<ChatMemberResponse> members) {
}
