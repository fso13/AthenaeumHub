package ru.krug.backend.notification.application.model;

import java.util.List;

/** One page of the caller's inbox plus the unread badge value. */
public record NotificationPageView(
        List<NotificationView> items,
        String nextCursor,
        boolean hasMore,
        long unreadCount) {

    public NotificationPageView {
        items = items == null ? List.of() : List.copyOf(items);
    }
}
