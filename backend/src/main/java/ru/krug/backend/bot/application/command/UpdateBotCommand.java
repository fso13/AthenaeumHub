package ru.krug.backend.bot.application.command;

import java.util.List;
import java.util.UUID;

/**
 * {@code PATCH /workspaces/{workspaceId}/bots/{botId}} body. Absent fields are unchanged;
 * {@code clearAvatar=true} removes the avatar reference. There is no way to set a raw token.
 *
 * <p>#98: {@code eventsUrl == null} means unchanged, a blank value clears the endpoint;
 * {@code events == null} means unchanged, an empty list unsubscribes all; {@code commands ==
 * null} means unchanged.</p>
 */
public record UpdateBotCommand(String name, List<String> scopes, UUID avatarFileId,
                               boolean clearAvatar, String status, String eventsUrl,
                               List<String> events, Boolean eventsEnabled,
                               List<BotCommandInput> commands) {
}
