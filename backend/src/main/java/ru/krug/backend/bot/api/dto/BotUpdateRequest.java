package ru.krug.backend.bot.api.dto;

import java.util.List;
import java.util.UUID;

/**
 * {@code PATCH /workspaces/{workspaceId}/bots/{botId}}. Absent fields are unchanged;
 * {@code clear_avatar=true} removes the avatar. Credentials are rotated only via the
 * dedicated token/secret endpoints.
 *
 * <p>#98: a blank {@code events_url} clears the endpoint and disables delivery;
 * {@code events=[]} unsubscribes all; {@code commands} replaces the registered slash-command
 * list. Setting a non-empty event configuration generates a signing secret when none exists
 * and reveals it once in the response ({@code signing_secret}).</p>
 */
public record BotUpdateRequest(String name, List<String> scopes, UUID avatarFileId,
                               Boolean clearAvatar, String status, String eventsUrl,
                               List<String> events, Boolean eventsEnabled,
                               List<BotCommandRequest> commands, Boolean enabled) {
}
