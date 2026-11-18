package ru.krug.backend.sticker.infrastructure.persistence;

import java.io.Serializable;
import java.util.Objects;
import java.util.UUID;

/** Composite id for the per-user favorites table. */
public class StickerFavoriteId implements Serializable {

    private UUID userId;
    private UUID stickerId;

    protected StickerFavoriteId() {
    }

    public StickerFavoriteId(UUID userId, UUID stickerId) {
        this.userId = userId;
        this.stickerId = stickerId;
    }

    public UUID getUserId() {
        return userId;
    }

    public UUID getStickerId() {
        return stickerId;
    }

    @Override
    public boolean equals(Object other) {
        if (this == other) {
            return true;
        }
        if (!(other instanceof StickerFavoriteId that)) {
            return false;
        }
        return Objects.equals(userId, that.userId) && Objects.equals(stickerId, that.stickerId);
    }

    @Override
    public int hashCode() {
        return Objects.hash(userId, stickerId);
    }
}
