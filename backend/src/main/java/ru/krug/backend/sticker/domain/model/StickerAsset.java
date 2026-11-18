package ru.krug.backend.sticker.domain.model;

import java.util.Objects;

/**
 * Sticker image metadata from SYSTEM-ANALYSIS §12.7: PNG/WebP/APNG only, exactly 512x512,
 * at most 512 KiB. The URL is the stored asset location; absolute-URL expansion is an
 * infrastructure concern behind {@code StickerAssetUrlResolver}.
 */
public record StickerAsset(
        String url,
        StickerFormat format,
        int width,
        int height,
        long sizeBytes) {

    public static final int REQUIRED_WIDTH = 512;
    public static final int REQUIRED_HEIGHT = 512;
    public static final long MAX_SIZE_BYTES = 512L * 1024L;

    public StickerAsset {
        if (url == null || url.isBlank()) {
            throw new IllegalArgumentException("sticker url must not be blank");
        }
        Objects.requireNonNull(format, "format");
        if (width != REQUIRED_WIDTH || height != REQUIRED_HEIGHT) {
            throw new IllegalArgumentException("sticker must be exactly 512x512");
        }
        if (sizeBytes <= 0 || sizeBytes > MAX_SIZE_BYTES) {
            throw new IllegalArgumentException("sticker size must be within 1..524288 bytes");
        }
    }
}
