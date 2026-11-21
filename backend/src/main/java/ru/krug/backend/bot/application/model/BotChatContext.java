package ru.krug.backend.bot.application.model;

import java.util.UUID;

/**
 * Chat state needed by the bot-send path. The adapter resolves it after the tenant GUC is
 * active; the service decides the HTTP error (hidden 404 for a missing/foreign/deleted chat,
 * 422 for E2EE, 403 for a missing/disabled installation).
 */
public record BotChatContext(UUID workspaceId, String securityMode, boolean installed,
                             boolean enabled) {
}
