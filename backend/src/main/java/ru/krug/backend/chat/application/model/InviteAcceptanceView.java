package ru.krug.backend.chat.application.model;

import java.util.UUID;

/** Result of accepting an invite link (#79). */
public record InviteAcceptanceView(
        UUID inviteId,
        UUID workspaceId,
        UUID chatId,
        String role,
        boolean alreadyMember) {
}
