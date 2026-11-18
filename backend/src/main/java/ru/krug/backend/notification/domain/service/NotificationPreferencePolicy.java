package ru.krug.backend.notification.domain.service;

import java.util.List;
import java.util.UUID;

import ru.krug.backend.notification.domain.model.Channel;
import ru.krug.backend.notification.domain.model.Mode;
import ru.krug.backend.notification.domain.model.NotificationPreference;
import ru.krug.backend.notification.domain.model.NotificationType;

/**
 * Preference precedence: exact chat-scoped row, then workspace-global row, then the
 * channel default. IN_APP defaults to ALL (bell is on by default); EMAIL defaults to MUTE
 * because the E6 sender is a dev stub and email is opt-in.
 */
public final class NotificationPreferencePolicy {

    private NotificationPreferencePolicy() {
    }

    public static Mode resolve(List<NotificationPreference> preferences, UUID workspaceId,
                               UUID chatId, NotificationType type, Channel channel) {
        Mode exact = modeOf(preferences, workspaceId, chatId, type, channel);
        if (exact != null) {
            return exact;
        }
        Mode global = modeOf(preferences, workspaceId, null, type, channel);
        if (global != null) {
            return global;
        }
        return channel == Channel.IN_APP ? Mode.ALL : Mode.MUTE;
    }

    private static Mode modeOf(List<NotificationPreference> preferences, UUID workspaceId,
                               UUID chatId, NotificationType type, Channel channel) {
        if (preferences == null) {
            return null;
        }
        return preferences.stream()
                .filter(preference -> java.util.Objects.equals(preference.workspaceId(),
                        workspaceId))
                .filter(preference -> java.util.Objects.equals(preference.chatId(), chatId))
                .filter(preference -> preference.type() == type)
                .filter(preference -> preference.channel() == channel)
                .map(NotificationPreference::mode)
                .findFirst()
                .orElse(null);
    }
}
