package ru.krug.backend.chat.domain.model;

import java.time.Instant;
import java.util.Objects;
import java.util.UUID;

/**
 * Per-chat seq allocator aggregate. The invariant: seq is strictly positive, every call
 * returns a fresh value, and a rolled-back transaction may leave a gap (allowed by design).
 */
public final class ChatCounter {

    private final UUID chatId;
    private long nextSeq;
    private Instant lastMessageAt;

    private ChatCounter(UUID chatId, long nextSeq, Instant lastMessageAt) {
        this.chatId = Objects.requireNonNull(chatId, "chatId");
        if (nextSeq <= 0) {
            throw new IllegalArgumentException("next_seq must be > 0");
        }
        this.nextSeq = nextSeq;
        this.lastMessageAt = lastMessageAt;
    }

    public static ChatCounter newCounter(UUID chatId) {
        return new ChatCounter(chatId, 1, null);
    }

    public static ChatCounter reconstitute(UUID chatId, long nextSeq, Instant lastMessageAt) {
        return new ChatCounter(chatId, nextSeq, lastMessageAt);
    }

    /**
     * Allocates the next seq and advances the counter. Gaps after rollback are allowed;
     * reusing a value is not.
     */
    public long allocate(Instant at) {
        long allocated = nextSeq;
        nextSeq = nextSeq + 1;
        lastMessageAt = at;
        return allocated;
    }

    public long lastSeq() {
        return nextSeq - 1;
    }

    public UUID chatId() {
        return chatId;
    }

    public long nextSeq() {
        return nextSeq;
    }

    public Instant lastMessageAt() {
        return lastMessageAt;
    }
}
