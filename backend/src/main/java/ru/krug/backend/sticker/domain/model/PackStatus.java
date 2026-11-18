package ru.krug.backend.sticker.domain.model;

/**
 * Sticker pack lifecycle (SYSTEM-ANALYSIS §9.5). E5 only seeds ACTIVE built-in packs;
 * DISABLED keeps history renderable but forbids new sends (409 STICKER_PACK_DISABLED).
 */
public enum PackStatus {
    DRAFT,
    IN_REVIEW,
    ACTIVE,
    DISABLED,
    REJECTED,
    REMOVED;

    public boolean isUsable() {
        return this == ACTIVE;
    }
}
