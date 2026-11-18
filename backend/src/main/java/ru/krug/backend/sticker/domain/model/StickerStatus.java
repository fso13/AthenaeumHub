package ru.krug.backend.sticker.domain.model;

/** Sticker lifecycle; only ACTIVE stickers can be favorited or sent. */
public enum StickerStatus {
    ACTIVE,
    DISABLED,
    REMOVED;

    public boolean isUsable() {
        return this == ACTIVE;
    }
}
