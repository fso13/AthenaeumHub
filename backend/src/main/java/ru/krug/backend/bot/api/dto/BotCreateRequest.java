package ru.krug.backend.bot.api.dto;

import java.util.List;

/** {@code POST /workspaces/{workspaceId}/bots}. The response carries the one-time token. */
public record BotCreateRequest(String name, List<String> scopes) {
}
