package ru.krug.backend.notification.domain.model;

import java.time.Instant;
import java.util.Objects;
import java.util.UUID;

/**
 * In-app notification aggregate. E6 creates one row per recipient on
 * {@code message.created}; the message sender is excluded before the aggregate exists.
 *
 * <p>Privacy invariant: the body is always {@code null} in E6-Even for MANAGED chats the
 * default is no content, and E2EE content must never reach this module. Only a generic
 * title plus chat metadata (resolved at read time) are stored.</p>
 */
public final class Notification {

    public static final String NEW_MESSAGE_TITLE = "Новое сообщение";
    private static final int MAX_TITLE_LENGTH = 200;
    private static final int MAX_DEDUPE_KEY_LENGTH = 400;

    private final UUID id;
    private final UUID userId;
    private final UUID workspaceId;
    private final UUID chatId;
    private final NotificationType type;
    private final String title;
    private final String body;
    private final String dedupeKey;
    private final Instant readAt;
    private final Instant createdAt;

    private Notification(UUID id, UUID userId, UUID workspaceId, UUID chatId,
                         NotificationType type, String title, String body, String dedupeKey,
                         Instant readAt, Instant createdAt) {
        this.id = Objects.requireNonNull(id, "id");
        this.userId = Objects.requireNonNull(userId, "userId");
        this.workspaceId = Objects.requireNonNull(workspaceId, "workspaceId");
        this.chatId = chatId;
        this.type = Objects.requireNonNull(type, "type");
        this.title = requireTitle(title);
        this.body = body;
        this.dedupeKey = requireDedupeKey(dedupeKey);
        this.readAt = readAt;
        this.createdAt = Objects.requireNonNull(createdAt, "createdAt");
    }

    /**
     * Creates a generic in-app notification. The body is deliberately absent from the
     * signature: no caller can smuggle message content into the notification module.
     */
    public static Notification create(UUID id, UUID userId, UUID workspaceId, UUID chatId,
                                      NotificationType type, String title, String dedupeKey,
                                      Instant createdAt) {
        return new Notification(id, userId, workspaceId, chatId, type, title, null, dedupeKey,
                null, createdAt);
    }

    public static Notification reconstitute(UUID id, UUID userId, UUID workspaceId, UUID chatId,
                                            NotificationType type, String title, String body,
                                            String dedupeKey, Instant readAt, Instant createdAt) {
        return new Notification(id, userId, workspaceId, chatId, type, title, body, dedupeKey,
                readAt, createdAt);
    }

    /** Dedupe key from E6-D-03: {@code (user_id, chat_id, message_id, type)}. */
    public static String dedupeKey(UUID userId, UUID chatId, UUID messageId,
                                   NotificationType type) {
        return userId + ":" + chatId + ":" + messageId + ":" + type.name();
    }

    public Notification markRead(Instant at) {
        if (readAt != null) {
            return this;
        }
        return new Notification(id, userId, workspaceId, chatId, type, title, body, dedupeKey,
                Objects.requireNonNull(at, "at"), createdAt);
    }

    public boolean isRead() {
        return readAt != null;
    }

    public UUID id() {
        return id;
    }

    public UUID userId() {
        return userId;
    }

    public UUID workspaceId() {
        return workspaceId;
    }

    public UUID chatId() {
        return chatId;
    }

    public NotificationType type() {
        return type;
    }

    public String title() {
        return title;
    }

    public String body() {
        return body;
    }

    public String dedupeKey() {
        return dedupeKey;
    }

    public Instant readAt() {
        return readAt;
    }

    public Instant createdAt() {
        return createdAt;
    }

    private static String requireTitle(String value) {
        if (value == null || value.isBlank() || value.length() > MAX_TITLE_LENGTH) {
            throw new IllegalArgumentException("Notification title must be 1..200 characters");
        }
        return value;
    }

    private static String requireDedupeKey(String value) {
        if (value == null || value.isBlank() || value.length() > MAX_DEDUPE_KEY_LENGTH) {
            throw new IllegalArgumentException("Notification dedupe key must be 1..400 characters");
        }
        return value;
    }
}
