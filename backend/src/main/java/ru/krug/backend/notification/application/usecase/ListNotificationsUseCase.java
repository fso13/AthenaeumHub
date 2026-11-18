package ru.krug.backend.notification.application.usecase;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.notification.application.model.NotificationPageCursor;
import ru.krug.backend.notification.application.model.NotificationPageView;
import ru.krug.backend.notification.application.model.NotificationView;
import ru.krug.backend.notification.application.port.ChatDirectoryPort;
import ru.krug.backend.notification.domain.model.Notification;
import ru.krug.backend.notification.domain.repository.NotificationRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.TenantContext;
import ru.krug.backend.shared.error.DomainException;

/** GET /notifications: own inbox, newest first, stable cursor page plus unread_count. */
@Service
public class ListNotificationsUseCase {

    private static final int DEFAULT_LIMIT = 30;
    private static final int MAX_LIMIT = 100;

    private final TenantContext tenantContext;
    private final NotificationRepository notifications;
    private final ChatDirectoryPort chatDirectory;

    public ListNotificationsUseCase(TenantContext tenantContext,
                                    NotificationRepository notifications,
                                    ChatDirectoryPort chatDirectory) {
        this.tenantContext = tenantContext;
        this.notifications = notifications;
        this.chatDirectory = chatDirectory;
    }

    @Transactional(readOnly = true)
    public NotificationPageView list(Principal principal, String cursor, Integer requestedLimit) {
        int limit = effectiveLimit(requestedLimit);
        NotificationPageCursor decoded = cursor == null || cursor.isBlank()
                ? null : NotificationPageCursor.decode(cursor);

        tenantContext.activate(principal);
        List<Notification> rows = notifications.findPage(principal.userId(),
                decoded == null ? null : decoded.createdAt(),
                decoded == null ? null : decoded.id(), limit + 1);
        boolean hasMore = rows.size() > limit;
        List<Notification> page = hasMore ? rows.subList(0, limit) : rows;
        long unread = notifications.countUnread(principal.userId());

        String nextCursor = null;
        if (hasMore && !page.isEmpty()) {
            Notification last = page.get(page.size() - 1);
            nextCursor = new NotificationPageCursor(last.createdAt(), last.id()).encode();
        }

        Map<String, String> chatNames = new HashMap<>();
        NotificationView.ChatNameResolver resolver = (workspaceId, chatId) -> {
            if (chatId == null) {
                return null;
            }
            String key = workspaceId + "/" + chatId;
            if (chatNames.containsKey(key)) {
                return chatNames.get(key);
            }
            String name = chatDirectory.findChat(workspaceId, chatId)
                    .map(ChatDirectoryPort.ChatDirectory::name)
                    .orElse(null);
            chatNames.put(key, name);
            return name;
        };
        return new NotificationPageView(NotificationView.withChatNames(page, resolver),
                nextCursor, hasMore, unread);
    }

    private static int effectiveLimit(Integer requested) {
        int limit = requested == null ? DEFAULT_LIMIT : requested;
        if (limit < 1 || limit > MAX_LIMIT) {
            throw DomainException.badRequest("limit must be between 1 and 100",
                    Map.of("field", "limit", "min", 1, "max", MAX_LIMIT));
        }
        return limit;
    }
}
