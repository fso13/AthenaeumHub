package ru.krug.backend.message.domain.model;

import java.time.Instant;
import java.util.Objects;
import java.util.UUID;

/**
 * One recipient of a mention on a managed message (#83).
 *
 * <p>{@code @all} is materialised at send time into one row per active chat member, so the
 * read model never has to expand an audience later (a member added after the message does
 * not inherit an older @all). The row is also the per-user read marker for
 * {@code GET /me/mentions}. {@code mentionAll} records whether the row came from @all, which
 * lets moderation/analytics distinguish a broad ping from a direct mention.
 */
public final class MessageMention {

    private final UUID id;
    private final UUID workspaceId;
    private final UUID chatId;
    private final UUID messageId;
    private final UUID userId;
    private final boolean mentionAll;
    private final Instant readAt;
    private final Instant createdAt;

    private MessageMention(UUID id, UUID workspaceId, UUID chatId, UUID messageId, UUID userId,
                           boolean mentionAll, Instant readAt, Instant createdAt) {
        this.id = Objects.requireNonNull(id, "id");
        this.workspaceId = Objects.requireNonNull(workspaceId, "workspaceId");
        this.chatId = Objects.requireNonNull(chatId, "chatId");
        this.messageId = Objects.requireNonNull(messageId, "messageId");
        this.userId = Objects.requireNonNull(userId, "userId");
        this.mentionAll = mentionAll;
        this.readAt = readAt;
        this.createdAt = Objects.requireNonNull(createdAt, "createdAt");
    }

    public static MessageMention create(UUID id, UUID workspaceId, UUID chatId, UUID messageId,
                                        UUID userId, boolean mentionAll, Instant createdAt) {
        return new MessageMention(id, workspaceId, chatId, messageId, userId, mentionAll, null,
                createdAt);
    }

    public static MessageMention reconstitute(UUID id, UUID workspaceId, UUID chatId,
                                              UUID messageId, UUID userId, boolean mentionAll,
                                              Instant readAt, Instant createdAt) {
        return new MessageMention(id, workspaceId, chatId, messageId, userId, mentionAll, readAt,
                createdAt);
    }

    public MessageMention markRead(Instant at) {
        if (readAt != null) {
            return this;
        }
        return new MessageMention(id, workspaceId, chatId, messageId, userId, mentionAll,
                Objects.requireNonNull(at, "at"), createdAt);
    }

    public boolean isRead() {
        return readAt != null;
    }

    public UUID id() {
        return id;
    }

    public UUID workspaceId() {
        return workspaceId;
    }

    public UUID chatId() {
        return chatId;
    }

    public UUID messageId() {
        return messageId;
    }

    public UUID userId() {
        return userId;
    }

    public boolean mentionAll() {
        return mentionAll;
    }

    public Instant readAt() {
        return readAt;
    }

    public Instant createdAt() {
        return createdAt;
    }
}
