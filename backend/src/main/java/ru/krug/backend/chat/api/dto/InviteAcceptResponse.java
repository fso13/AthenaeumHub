package ru.krug.backend.chat.api.dto;

import java.util.UUID;

/** OpenAPI {@code InviteAcceptResult} (#79). */
public record InviteAcceptResponse(
        UUID inviteId,
        UUID workspaceId,
        UUID chatId,
        String role,
        boolean alreadyMember) {
}
