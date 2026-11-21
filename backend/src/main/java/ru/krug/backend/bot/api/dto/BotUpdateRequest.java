package ru.krug.backend.bot.api.dto;

import java.util.List;
import java.util.UUID;

/**
 * {@code PATCH /workspaces/{workspaceId}/bots/{botId}}. Absent fields are unchanged;
 * {@code clear_avatar=true} removes the avatar. Credentials are rotated only via the
 * dedicated token endpoint.
 */
public record BotUpdateRequest(String name, List<String> scopes, UUID avatarFileId,
                               Boolean clearAvatar, String status) {
}
