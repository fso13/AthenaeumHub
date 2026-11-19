package ru.krug.backend.message.infrastructure.persistence;

import java.io.Serializable;
import java.time.Instant;
import java.util.Objects;
import java.util.UUID;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.IdClass;
import jakarta.persistence.Table;

/**
 * Read-only mapping of {@code message.message_deletions}, used by the timeline JPQL
 * {@code not exists} predicate. Writes go through the native idempotent insert in
 * {@link MessageRepositoryAdapter} so an existing marker keeps its original timestamp.
 */
@Entity
@Table(name = "message_deletions", schema = "message")
@IdClass(MessageDeletionEntity.Key.class)
public class MessageDeletionEntity {

    @Id
    @Column(name = "message_id")
    private UUID messageId;

    @Id
    @Column(name = "user_id")
    private UUID userId;

    @Column(name = "workspace_id", nullable = false)
    private UUID workspaceId;

    @Column(name = "chat_id", nullable = false)
    private UUID chatId;

    @Column(name = "deleted_at", nullable = false)
    private Instant deletedAt;

    protected MessageDeletionEntity() {
    }

    public static class Key implements Serializable {

        private UUID messageId;
        private UUID userId;

        public Key() {
        }

        public Key(UUID messageId, UUID userId) {
            this.messageId = messageId;
            this.userId = userId;
        }

        @Override
        public boolean equals(Object other) {
            if (this == other) {
                return true;
            }
            if (!(other instanceof Key key)) {
                return false;
            }
            return Objects.equals(messageId, key.messageId)
                    && Objects.equals(userId, key.userId);
        }

        @Override
        public int hashCode() {
            return Objects.hash(messageId, userId);
        }
    }
}
