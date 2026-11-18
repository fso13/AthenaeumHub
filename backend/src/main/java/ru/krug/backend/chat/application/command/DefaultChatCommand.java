package ru.krug.backend.chat.application.command;

import java.util.UUID;

/**
 * Cross-context command for workspace onboarding. The security mode is a plain string so
 * the workspace context does not depend on the chat domain.
 */
public record DefaultChatCommand(
        UUID chatId,
        UUID workspaceId,
        UUID ownerId,
        String name,
        String securityMode) {
}
