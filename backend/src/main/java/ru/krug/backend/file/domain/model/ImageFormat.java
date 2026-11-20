package ru.krug.backend.file.domain.model;

import java.util.List;
import java.util.Locale;

/**
 * The only image formats accepted by the direct image pipeline. SVG (active content) and
 * GIF (animation, legacy decoder attack surface) are deliberately absent and cannot be
 * re-enabled by the client: detection is by magic bytes, never by {@code Content-Type}.
 */
public enum ImageFormat {

    PNG("image/png", List.of("png")),
    JPEG("image/jpeg", List.of("jpg", "jpeg")),
    WEBP("image/webp", List.of("webp"));

    private final String mime;
    private final List<String> extensions;

    ImageFormat(String mime, List<String> extensions) {
        this.mime = mime;
        this.extensions = extensions;
    }

    public String mime() {
        return mime;
    }

    /** Extension used when the client did not supply a usable one. */
    public String canonicalExtension() {
        return extensions.get(0);
    }

    public boolean matchesExtension(String extension) {
        if (extension == null || extension.isBlank()) {
            return false;
        }
        return extensions.contains(extension.toLowerCase(Locale.ROOT));
    }
}
