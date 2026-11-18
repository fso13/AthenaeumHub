package ru.krug.backend.notification.api.mapper;

import java.util.List;

import ru.krug.backend.notification.api.dto.NotificationPageResponse;
import ru.krug.backend.notification.api.dto.NotificationPreferenceResponse;
import ru.krug.backend.notification.api.dto.NotificationPreferencesResponse;
import ru.krug.backend.notification.api.dto.NotificationResponse;
import ru.krug.backend.notification.application.model.NotificationPageView;
import ru.krug.backend.notification.application.model.NotificationPreferenceView;
import ru.krug.backend.notification.application.model.NotificationView;

/** API ↔ application mapping. Controllers never expose domain/application objects. */
public final class NotificationApiMapper {

    private NotificationApiMapper() {
    }

    public static NotificationResponse toResponse(NotificationView view) {
        return new NotificationResponse(view.id(), view.typeName(), view.chatId(),
                view.chatName(), view.title(), view.body(), view.createdAt(), view.read());
    }

    public static NotificationPageResponse toPage(NotificationPageView view) {
        return new NotificationPageResponse(view.items().stream()
                .map(NotificationApiMapper::toResponse).toList(),
                new NotificationPageResponse.PageInfo(view.nextCursor(), view.hasMore()),
                view.unreadCount());
    }

    public static NotificationPreferenceResponse toResponse(NotificationPreferenceView view) {
        return new NotificationPreferenceResponse(view.chatId(), view.typeName(),
                view.channelName(), view.modeName());
    }

    public static NotificationPreferencesResponse toPreferences(
            List<NotificationPreferenceView> views) {
        return new NotificationPreferencesResponse(views.stream()
                .map(NotificationApiMapper::toResponse).toList());
    }
}
