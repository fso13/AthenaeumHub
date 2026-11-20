package ru.krug.backend.message.infrastructure.persistence;

import java.time.Instant;
import java.util.UUID;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import ru.krug.backend.message.domain.model.MessageMention;

/** JPA mapping of {@code message.mentions} (#83). */
@Entity
@Table(name = "mentions", schema = "message")
public class MessageMentionEntity {

    @Id
    private UUID id;

    @Column(name = "workspace_id", nullable = false)
    private UUID workspaceId;

    @Column(name = "chat_id", nullable = false)
    private UUID chatId;

    @Column(name = "message_id", nullable = false)
    private UUID messageId;

    @Column(name = "user_id", nullable = false)
    private UUID userId;

    @Column(name = "mention_all", nullable = false)
    private boolean mentionAll;

    @Column(name = "read_at")
    private Instant readAt;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    protected MessageMentionEntity() {
    }

    public static MessageMentionEntity from(MessageMention mention) {
        MessageMentionEntity entity = new MessageMentionEntity();
        entity.id = mention.id();
        entity.workspaceId = mention.workspaceId();
        entity.chatId = mention.chatId();
        entity.messageId = mention.messageId();
        entity.userId = mention.userId();
        entity.mentionAll = mention.mentionAll();
        entity.readAt = mention.readAt();
        entity.createdAt = mention.createdAt();
        return entity;
    }

    public MessageMention toDomain() {
        return MessageMention.reconstitute(id, workspaceId, chatId, messageId, userId,
                mentionAll, readAt, createdAt);
    }
}
