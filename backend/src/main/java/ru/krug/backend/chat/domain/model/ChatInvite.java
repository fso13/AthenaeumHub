package ru.krug.backend.chat.domain.model;

import java.time.Instant;
import java.util.Objects;
import java.util.UUID;

/**
 * GROUP-channel invite link (#79). The entity deliberately has no token field: the raw
 * token exists only in the create response and the database stores its SHA-256 hash.
 */
public final class ChatInvite {

    public enum Status {
        ACTIVE, EXPIRED, EXHAUSTED, REVOKED
    }

    private final UUID id;
    private final UUID chatId;
    private final ChatMember.Role role;
    private final Integer maxUses;
    private final int usedCount;
    private final Instant expiresAt;
    private final Instant revokedAt;
    private final Instant createdAt;
    private final UUID createdBy;

    private ChatInvite(UUID id, UUID chatId, ChatMember.Role role, Integer maxUses,
                       int usedCount, Instant expiresAt, Instant revokedAt, Instant createdAt,
                       UUID createdBy) {
        this.id = Objects.requireNonNull(id, "id");
        this.chatId = Objects.requireNonNull(chatId, "chatId");
        this.role = Objects.requireNonNull(role, "role");
        // OWNER is never granted through a link: an owner is promoted explicitly (PATCH).
        if (role == ChatMember.Role.OWNER) {
            throw new IllegalArgumentException("An invite link cannot grant OWNER");
        }
        if (maxUses != null && (maxUses < 1 || maxUses > 1000)) {
            throw new IllegalArgumentException("maxUses must be 1..1000 or null");
        }
        if (usedCount < 0 || (maxUses != null && usedCount > maxUses)) {
            throw new IllegalArgumentException("usedCount is outside 0..maxUses");
        }
        this.maxUses = maxUses;
        this.usedCount = usedCount;
        this.expiresAt = Objects.requireNonNull(expiresAt, "expiresAt");
        this.revokedAt = revokedAt;
        this.createdAt = createdAt;
        this.createdBy = createdBy;
    }

    public static ChatInvite create(UUID id, UUID chatId, ChatMember.Role role, Integer maxUses,
                                    Instant expiresAt, Instant createdAt, UUID createdBy) {
        return new ChatInvite(id, chatId, role, maxUses, 0, expiresAt, null, createdAt,
                createdBy);
    }

    public static ChatInvite reconstitute(UUID id, UUID chatId, ChatMember.Role role,
                                          Integer maxUses, int usedCount, Instant expiresAt,
                                          Instant revokedAt, Instant createdAt,
                                          UUID createdBy) {
        return new ChatInvite(id, chatId, role, maxUses, usedCount, expiresAt, revokedAt,
                createdAt, createdBy);
    }

    /**
     * Server-computed status. Revocation wins over expiry, expiry over exhaustion: a
     * revoked link is never reported as merely expired.
     */
    public Status status(Instant now) {
        if (revokedAt != null) {
            return Status.REVOKED;
        }
        if (expiresAt != null && !expiresAt.isAfter(now)) {
            return Status.EXPIRED;
        }
        if (maxUses != null && usedCount >= maxUses) {
            return Status.EXHAUSTED;
        }
        return Status.ACTIVE;
    }

    public UUID id() {
        return id;
    }

    public UUID chatId() {
        return chatId;
    }

    public ChatMember.Role role() {
        return role;
    }

    public Integer maxUses() {
        return maxUses;
    }

    public int usedCount() {
        return usedCount;
    }

    public Instant expiresAt() {
        return expiresAt;
    }

    public Instant revokedAt() {
        return revokedAt;
    }

    public Instant createdAt() {
        return createdAt;
    }

    public UUID createdBy() {
        return createdBy;
    }
}
