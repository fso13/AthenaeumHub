package ru.krug.backend.chat.application.command;

import java.util.Map;
import java.util.UUID;

/**
 * {@code PATCH /chats/{chatId}} (D1-BE3 + P0-2). Null means "field not provided".
 *
 * <p>{@code name}/{@code description} keep the D1-BE3 rule (workspace OWNER/ADMIN), extended
 * with a channel role that has {@code change_info}. The structural channel fields
 * ({@code coverFileId}, {@code readOnly}, {@code visibility}, {@code joinPolicy},
 * {@code rights}) require an ACTIVE chat OWNER/ADMIN and a GROUP chat.</p>
 *
 * <p>{@code rights} carries wire values ({@code {"ADMIN": {"post_messages": true}}}) so the
 * API layer never depends on domain enums; parsing/validation happens in the application and
 * domain layers.</p>
 */
public record ChatUpdateCommand(
        String name,
        String description,
        UUID coverFileId,
        Boolean readOnly,
        String visibility,
        String joinPolicy,
        Map<String, Map<String, Boolean>> rights) {

    public boolean isEmpty() {
        return name == null && description == null && !hasChannelSettings();
    }

    public boolean hasChannelSettings() {
        return coverFileId != null || readOnly != null || visibility != null
                || joinPolicy != null || rights != null;
    }

    public boolean changesInfo() {
        return name != null || description != null || coverFileId != null;
    }
}
