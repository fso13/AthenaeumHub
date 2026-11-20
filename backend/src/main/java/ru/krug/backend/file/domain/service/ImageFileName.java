package ru.krug.backend.file.domain.service;

import java.util.Locale;
import java.util.Map;

import ru.krug.backend.file.domain.exception.InvalidImageException;
import ru.krug.backend.file.domain.model.ImageFormat;
import ru.krug.backend.shared.error.DomainException;

/**
 * Filename policy for direct images.
 *
 * <p>The filename is never used to build the object key (that is
 * {@code workspaces/<uuid>/images/<attachment-uuid>}), so traversal cannot escape storage
 * even if a client sends it. It is still rejected up front instead of being normalized:
 * a name containing a path separator, {@code ..}, a control/bidi character or more than 255
 * characters is a malformed request (400). The extension is part of the scan policy and must
 * agree with the magic-byte format; a name without an extension is accepted and gets the
 * canonical one.
 */
public final class ImageFileName {

    public static final int MAX_LENGTH = 255;

    private ImageFileName() {
    }

    /** @throws DomainException 400 for a malformed/unsafe name; blank means "no name". */
    public static String sanitize(String raw) {
        if (raw == null) {
            return "";
        }
        String value = raw.strip();
        if (value.isEmpty()) {
            return "";
        }
        if (value.length() > MAX_LENGTH) {
            throw DomainException.badRequest("filename must be at most 255 characters",
                    Map.of("field", "file"));
        }
        if (".".equals(value) || value.contains("..")) {
            throw DomainException.badRequest("filename must not contain a path",
                    Map.of("field", "file", "reason", "path_traversal"));
        }
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            if (character == '/' || character == '\\' || character == '\0'
                    || Character.isISOControl(character) || isBidiControl(character)) {
                throw DomainException.badRequest("filename contains an unsafe character",
                        Map.of("field", "file", "reason", "unsafe_filename"));
            }
        }
        return value;
    }

    public static String extensionOf(String filename) {
        if (filename == null) {
            return "";
        }
        int dot = filename.lastIndexOf('.');
        if (dot < 0 || dot == filename.length() - 1) {
            return "";
        }
        return filename.substring(dot + 1).toLowerCase(Locale.ROOT);
    }

    /**
     * Enforces "extension must match magic" when an extension is present and returns the
     * name that will be stored in the attachment row.
     *
     * @throws InvalidImageException 422 when the extension contradicts the detected format
     */
    public static String storedName(String sanitized, ImageFormat format) {
        String extension = extensionOf(sanitized);
        if (extension.isEmpty()) {
            return "image." + format.canonicalExtension();
        }
        if (!format.matchesExtension(extension)) {
            throw new InvalidImageException("extension_mismatch",
                    Map.of("extension", extension, "detected_mime", format.mime()));
        }
        return sanitized;
    }

    private static boolean isBidiControl(char character) {
        return (character >= '\u202A' && character <= '\u202E')
                || (character >= '\u2066' && character <= '\u2069')
                || character == '\u200E' || character == '\u200F';
    }
}
