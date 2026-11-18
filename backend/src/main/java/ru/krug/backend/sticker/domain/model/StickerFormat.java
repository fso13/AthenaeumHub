package ru.krug.backend.sticker.domain.model;

/**
 * Allowed sticker image containers. SVG/HTML are explicitly excluded by
 * SYSTEM-ANALYSIS §12.7; APNG is a valid container but E5 demo assets are static PNG.
 */
public enum StickerFormat {
    PNG,
    WEBP,
    APNG
}
