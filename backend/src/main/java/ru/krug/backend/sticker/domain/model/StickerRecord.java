package ru.krug.backend.sticker.domain.model;

/**
 * Read projection: a sticker together with its pack status. The catalog needs both to
 * distinguish "unknown/inactive sticker" (404/410) from "pack disabled" (409).
 */
public record StickerRecord(Sticker sticker, PackStatus packStatus, boolean builtin) {

    public boolean isUsable() {
        return sticker.isActive() && packStatus.isUsable();
    }
}
