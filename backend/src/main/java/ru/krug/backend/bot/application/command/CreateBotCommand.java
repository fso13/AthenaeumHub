package ru.krug.backend.bot.application.command;

import java.util.List;

/** {@code POST /workspaces/{workspaceId}/bots} body. */
public record CreateBotCommand(String name, List<String> scopes) {
}
