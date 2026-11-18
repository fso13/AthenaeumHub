package ru.krug.backend.chat.application.command;

import java.util.UUID;

public record DevChatCommand(UUID chatId, UUID workspaceId, UUID ownerId, String name) {
}
