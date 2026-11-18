package ru.krug.backend.chat.infrastructure.persistence;

import java.time.Instant;
import java.util.UUID;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

@Entity
@Table(name = "chat_counters", schema = "chat")
public class ChatCounterEntity {

    @Id
    @Column(name = "chat_id")
    private UUID chatId;

    @Column(name = "workspace_id", nullable = false)
    private UUID workspaceId;

    @Column(name = "next_seq", nullable = false)
    private Long nextSeq;

    @Column(name = "last_message_at")
    private Instant lastMessageAt;

    protected ChatCounterEntity() {
    }

    public UUID getChatId() {
        return chatId;
    }

    public Long getNextSeq() {
        return nextSeq;
    }

    public Instant getLastMessageAt() {
        return lastMessageAt;
    }
}
