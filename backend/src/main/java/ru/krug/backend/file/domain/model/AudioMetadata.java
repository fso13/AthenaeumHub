package ru.krug.backend.file.domain.model;

import java.util.Arrays;

/**
 * Server-extracted audio metadata (#97). Produced by the bounded ID3/MP4 parser before it is
 * turned into a sanitized {@link MediaMetadata} with {@code metadata_source=SERVER}.
 *
 * <p>Values are already display-sanitized (no HTML/control/bidi characters, bounded length).
 * Artwork bytes are a decoded raster payload, never an external URL, so nothing here performs
 * network I/O and there is no SSRF surface.
 */
public record AudioMetadata(
        Long durationMs,
        String title,
        String artist,
        String album,
        String year,
        String genre,
        Artwork artwork) {

    public static final AudioMetadata EMPTY = new AudioMetadata(null, null, null, null, null,
            null, null);

    public AudioMetadata {
        // Artwork is immutable by contract; copy so a caller cannot mutate the parsed bytes.
        artwork = artwork == null ? null
                : new Artwork(artwork.mimeType(), artwork.bytes().clone());
    }

    public static AudioMetadata empty() {
        return EMPTY;
    }

    public boolean hasTags() {
        return title != null || artist != null || album != null || year != null
                || genre != null || durationMs != null;
    }

    public boolean isEmpty() {
        return !hasTags() && artwork == null;
    }

    /** A safe raster cover extracted from APIC/PIC/MP4 {@code covr}. */
    public record Artwork(String mimeType, byte[] bytes) {

        public Artwork {
            if (mimeType == null || mimeType.isBlank()) {
                throw new IllegalArgumentException("artwork mime is required");
            }
            if (bytes == null || bytes.length == 0) {
                throw new IllegalArgumentException("artwork bytes are required");
            }
            bytes = Arrays.copyOf(bytes, bytes.length);
        }

        @Override
        public byte[] bytes() {
            return bytes.clone();
        }
    }
}
