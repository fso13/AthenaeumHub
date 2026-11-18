package ru.krug.backend.sticker.infrastructure.persistence;

import java.time.Instant;
import java.util.UUID;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.IdClass;
import jakarta.persistence.Table;

/** JPA row of sticker.sticker_favorites; protected by per-user RLS. */
@Entity
@Table(name = "sticker_favorites", schema = "sticker")
@IdClass(StickerFavoriteId.class)
public class StickerFavoriteEntity {

    @Id
    @Column(name = "user_id", nullable = false)
    private UUID userId;

    @Id
    @Column(name = "sticker_id", nullable = false)
    private UUID stickerId;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    protected StickerFavoriteEntity() {
    }

    public UUID getUserId() {
        return userId;
    }

    public UUID getStickerId() {
        return stickerId;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }
}
