package ru.krug.backend.bot.application.command;

import java.util.List;
import java.util.UUID;

/**
 * {@code PATCH /workspaces/{workspaceId}/bots/{botId}} body. Absent fields are unchanged;
 * {@code clearAvatar=true} removes the avatar reference. There is no way to set a raw token.
 */
public record UpdateBotCommand(String name, List<String> scopes, UUID avatarFileId,
                               boolean clearAvatar, String status) {
}
