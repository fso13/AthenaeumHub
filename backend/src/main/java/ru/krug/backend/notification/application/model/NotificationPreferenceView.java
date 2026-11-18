package ru.krug.backend.notification.application.model;

import java.util.List;
import java.util.UUID;

import ru.krug.backend.notification.domain.model.Channel;
import ru.krug.backend.notification.domain.model.Mode;
import ru.krug.backend.notification.domain.model.NotificationPreference;
import ru.krug.backend.notification.domain.model.NotificationType;

/** Application read model for one notification preference row. */
public record NotificationPreferenceView(
        UUID chatId,
        NotificationType type,
        Channel channel,
        Mode mode) {

    public String typeName() {
        return type.name();
    }

    public String channelName() {
        return channel.name();
    }

    public String modeName() {
        return mode.name();
    }

    public static NotificationPreferenceView from(NotificationPreference preference) {
        return new NotificationPreferenceView(preference.chatId(), preference.type(),
                preference.channel(), preference.mode());
    }

    public static List<NotificationPreferenceView> from(
            List<NotificationPreference> preferences) {
        return preferences.stream().map(NotificationPreferenceView::from).toList();
    }
}
