package ru.krug.backend.sticker.domain.model;

import java.util.Comparator;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;

/**
 * Sticker pack aggregate root. ACTIVE requires 8..100 valid stickers and a cover
 * (SYSTEM-ANALYSIS §9.5/§12.7). Built-in packs are global and do not consume workspace
 * quota; custom packs are v1.
 */
public final class StickerPack {

    public static final int MIN_STICKERS = 8;
    public static final int MAX_STICKERS = 100;

    private final UUID id;
    private final String slug;
    private final String name;
    private final String coverUrl;
    private final PackStatus status;
    private final boolean builtin;
    private final List<Sticker> stickers;

    private StickerPack(UUID id, String slug, String name, String coverUrl, PackStatus status,
                        boolean builtin, List<Sticker> stickers) {
        this.id = Objects.requireNonNull(id, "id");
        if (slug == null || slug.isBlank()) {
            throw new IllegalArgumentException("slug must not be blank");
        }
        this.slug = slug;
        if (name == null || name.isBlank() || name.length() > 120) {
            throw new IllegalArgumentException("name must be 1..120 characters");
        }
        this.name = name;
        if (coverUrl == null || coverUrl.isBlank()) {
            throw new IllegalArgumentException("coverUrl must not be blank");
        }
        this.coverUrl = coverUrl;
        this.status = Objects.requireNonNull(status, "status");
        this.builtin = builtin;
        this.stickers = (stickers == null ? List.<Sticker>of() : stickers).stream()
                .sorted(Comparator.comparingInt(Sticker::position))
                .toList();
        if (status == PackStatus.ACTIVE
                && (this.stickers.size() < MIN_STICKERS || this.stickers.size() > MAX_STICKERS)) {
            throw new IllegalArgumentException("ACTIVE pack must contain 8..100 stickers");
        }
        for (Sticker sticker : this.stickers) {
            if (!sticker.packId().equals(id)) {
                throw new IllegalArgumentException("sticker belongs to another pack");
            }
        }
    }

    public static StickerPack reconstitute(UUID id, String slug, String name, String coverUrl,
                                           PackStatus status, boolean builtin,
                                           List<Sticker> stickers) {
        return new StickerPack(id, slug, name, coverUrl, status, builtin, stickers);
    }

    public UUID id() {
        return id;
    }

    public String slug() {
        return slug;
    }

    public String name() {
        return name;
    }

    public String coverUrl() {
        return coverUrl;
    }

    public PackStatus status() {
        return status;
    }

    public boolean builtin() {
        return builtin;
    }

    public List<Sticker> stickers() {
        return stickers;
    }

    public List<Sticker> activeStickers() {
        return stickers.stream().filter(Sticker::isActive).toList();
    }

    public Optional<Sticker> findSticker(UUID stickerId) {
        return stickers.stream().filter(sticker -> sticker.id().value().equals(stickerId))
                .findFirst();
    }

    public boolean isActive() {
        return status.isUsable();
    }
}
