package ru.krug.backend.notification.api.dto;

import java.util.List;

public record NotificationPageResponse(
        List<NotificationResponse> items,
        PageInfo page,
        long unreadCount) {

    public record PageInfo(String nextCursor, boolean hasMore) {
    }
}
