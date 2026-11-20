package ru.krug.backend.message.application.command;

import java.util.UUID;

import ru.krug.backend.shared.application.model.Principal;

/**
 * Raw {@code GET /workspaces/{workspaceId}/search/messages} parameters. The service validates
 * the query, the optional chat filter and the time window before touching the database; the
 * controller passes strings so a malformed instant/timestamp is a 400, not a binding error.
 */
public record SearchMessagesQuery(
        Principal principal,
        UUID workspaceId,
        String q,
        UUID chatId,
        String from,
        String to,
        String cursor,
        Integer limit) {
}
