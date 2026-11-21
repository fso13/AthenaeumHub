package ru.krug.backend.bot.application.model;

import java.util.List;
import java.util.UUID;

/**
 * Authenticated bot caller. It is deliberately not a {@code Principal}: a bot has no user id,
 * no device, no session, and no workspace role. Only the message-send use case consumes it.
 */
public record BotPrincipal(UUID botId, UUID workspaceId, String name, List<String> scopes,
                           String requestId) {

    public BotPrincipal {
        scopes = scopes == null ? List.of() : List.copyOf(scopes);
    }

    public boolean hasScope(String scope) {
        return scopes.contains(scope);
    }
}
