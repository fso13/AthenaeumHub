package ru.krug.backend.file.domain.service;

import java.nio.charset.StandardCharsets;
import java.util.Set;

/**
 * Raster-only artwork sniffing (#97). The declared APIC/MP4 MIME is never trusted: the bytes
 * decide the content type, and only a small set of static raster formats is accepted. SVG and
 * every executable/active-content type are deliberately absent, so an artwork object can never
 * become a script or an HTML document when served.
 */
public final class ArtworkImages {

    public static final Set<String> SAFE_MIME_TYPES = Set.of(
            "image/jpeg", "image/png", "image/webp", "image/gif", "image/bmp", "image/avif");

    private ArtworkImages() {
    }

    /** Content type inferred from magic bytes, or {@code null} for anything not on the list. */
    public static String sniffMimeType(byte[] bytes) {
        if (bytes == null || bytes.length < 2) {
            return null;
        }
        if (startsWith(bytes, new byte[] {(byte) 0xff, (byte) 0xd8, (byte) 0xff})) {
            return "image/jpeg";
        }
        if (startsWith(bytes, new byte[] {(byte) 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a,
                0x1a, 0x0a})) {
            return "image/png";
        }
        if (bytes.length >= 6 && ascii(bytes, 0, 3).equals("GIF")
                && (ascii(bytes, 3, 3).equals("87a") || ascii(bytes, 3, 3).equals("89a"))) {
            return "image/gif";
        }
        if (bytes.length >= 12 && ascii(bytes, 0, 4).equals("RIFF")
                && ascii(bytes, 8, 4).equals("WEBP")) {
            return "image/webp";
        }
        if (bytes.length >= 2 && bytes[0] == 'B' && bytes[1] == 'M') {
            return "image/bmp";
        }
        if (bytes.length >= 12 && ascii(bytes, 4, 4).equals("ftyp")) {
            String brand = ascii(bytes, 8, 4);
            if (brand.equals("avif") || brand.equals("avis")) {
                return "image/avif";
            }
        }
        return null;
    }

    public static boolean isSafeMimeType(String mimeType) {
        return mimeType != null && SAFE_MIME_TYPES.contains(mimeType);
    }

    private static boolean startsWith(byte[] bytes, byte[] prefix) {
        if (bytes.length < prefix.length) {
            return false;
        }
        for (int i = 0; i < prefix.length; i++) {
            if (bytes[i] != prefix[i]) {
                return false;
            }
        }
        return true;
    }

    /** ISO-8859-1 view, so a 4CC such as {@code ©nam} (0xA9) keeps its single char. */
    static String ascii(byte[] bytes, int offset, int length) {
        if (offset < 0 || length < 0 || offset + length > bytes.length) {
            return "";
        }
        return new String(bytes, offset, length, StandardCharsets.ISO_8859_1);
    }
}
