package ru.krug.backend.file.application.model;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Raw client supplied media metadata (API -> application). Values are still untrusted and
 * unwrapped; {@link ru.krug.backend.file.domain.model.MediaMetadata#sanitize} validates them
 * in the upload handler. Keeping this record in the application layer lets the API layer
 * depend only on application models (ArchUnit rule).
 */
public record MediaMetadataInput(
        String kind,
        Long durationMs,
        Integer width,
        Integer height,
        String title,
        String artist,
        String album,
        String year,
        String genre,
        String artworkUrl,
        String metadataSource) {

    /** Deterministic map for the Idempotency-Key request fingerprint; nulls omitted. */
    public Map<String, Object> canonicalMap() {
        Map<String, Object> map = new LinkedHashMap<>();
        put(map, "kind", kind);
        put(map, "duration_ms", durationMs);
        put(map, "width", width);
        put(map, "height", height);
        put(map, "title", title);
        put(map, "artist", artist);
        put(map, "album", album);
        put(map, "year", year);
        put(map, "genre", genre);
        put(map, "artwork_url", artworkUrl);
        put(map, "metadata_source", metadataSource);
        return map;
    }

    private static void put(Map<String, Object> map, String key, Object value) {
        if (value != null) {
            map.put(key, value);
        }
    }
}
