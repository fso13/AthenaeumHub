package ru.krug.backend.sticker.domain.model;

import java.util.Objects;
import java.util.UUID;

/** Sticker entity inside the {@link StickerPack} aggregate. */
public final class Sticker {

    private final StickerId id;
    private final UUID packId;
    private final String alt;
    private final StickerAsset asset;
    private final int position;
    private final StickerStatus status;

    private Sticker(StickerId id, UUID packId, String alt, StickerAsset asset, int position,
                    StickerStatus status) {
        this.id = Objects.requireNonNull(id, "id");
        this.packId = Objects.requireNonNull(packId, "packId");
        if (alt == null || alt.isBlank() || alt.length() > 120) {
            throw new IllegalArgumentException("alt must be 1..120 characters");
        }
        this.alt = alt;
        this.asset = Objects.requireNonNull(asset, "asset");
        if (position < 1) {
            throw new IllegalArgumentException("position must be > 0");
        }
        this.position = position;
        this.status = Objects.requireNonNull(status, "status");
    }

    public static Sticker create(StickerId id, UUID packId, String alt, StickerAsset asset,
                                 int position, StickerStatus status) {
        return new Sticker(id, packId, alt, asset, position, status);
    }

    public StickerId id() {
        return id;
    }

    public UUID packId() {
        return packId;
    }

    public String alt() {
        return alt;
    }

    public StickerAsset asset() {
        return asset;
    }

    public int position() {
        return position;
    }

    public StickerStatus status() {
        return status;
    }

    public boolean isActive() {
        return status.isUsable();
    }
}
