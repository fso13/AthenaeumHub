package ru.krug.backend.file.domain.model;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

import ru.krug.backend.file.domain.exception.MediaMetadataInvalidException;
import ru.krug.backend.file.domain.exception.UnsupportedFileTypeException;

/**
 * Sanitized, immutable media metadata attached to a managed attachment (D1-BE2).
 *
 * <p>This is deliberately a value object, not a parser. The client may parse ID3/read
 * dimensions; on MANAGED audio uploads the server also extracts ID3v2.2/2.3/2.4 and M4A
 * atoms itself (#97, {@code metadata_source=SERVER}). Nothing here touches the media bytes,
 * and {@code artworkUrl} is never fetched, so there is no server-side SSRF.
 *
 * <p>Invariants (mirrored by {@code file.media_metadata_valid} in V29 and by the OpenAPI
 * schema):
 * <ul>
 *   <li>{@code kind} and {@code metadataSource} are required enums;</li>
 *   <li>duration in {@code [0, 7 days]}, width/height in {@code [1, 16384]};</li>
 *   <li>title/artist/album ≤ 255, genre ≤ 64, year is exactly four digits;</li>
 *   <li>text is trimmed and may not contain HTML brackets or control/bidi characters;</li>
 *   <li>artwork is an absolute http(s) URL with a hostname (no credentials, no IP literal,
 *       no localhost/.local/.internal); the server never resolves or fetches it;</li>
 *   <li>voice MIME ({@code audio/webm}, {@code audio/ogg}) requires {@code kind=AUDIO} and
 *       a duration in {@code [1, 10 minutes]}.</li>
 * </ul>
 */
public record MediaMetadata(
        MediaKind kind,
        Long durationMs,
        Integer width,
        Integer height,
        String title,
        String artist,
        String album,
        String year,
        String genre,
        String artworkUrl,
        MediaMetadataSource metadataSource) {

    public static final long MAX_DURATION_MS = 7L * 24 * 60 * 60 * 1000;
    public static final long MAX_VOICE_DURATION_MS = 10L * 60 * 1000;
    public static final int MAX_DIMENSION = 16384;
    public static final int MAX_TITLE_LENGTH = 255;
    public static final int MAX_ARTIST_LENGTH = 255;
    public static final int MAX_ALBUM_LENGTH = 255;
    public static final int MAX_GENRE_LENGTH = 64;
    public static final int MAX_YEAR_LENGTH = 8;
    public static final int MAX_ARTWORK_URL_LENGTH = 2048;

    /** Voice recordings are produced by MediaRecorder as WebM (or Ogg on Safari/Firefox). */
    private static final Set<String> VOICE_MIME = Set.of("audio/webm", "audio/ogg");

    /** Audio kinds must stay inside this allowlist; arbitrary {@code audio/*} is not enough. */
    public static final List<String> AUDIO_ALLOWED = List.of(
            "audio/webm", "audio/ogg", "audio/mpeg", "audio/mp4", "audio/x-m4a", "audio/aac",
            "audio/wav", "audio/x-wav", "audio/flac", "audio/x-flac", "audio/opus");

    public MediaMetadata {
        if (kind == null) {
            throw invalid("media.kind", "required", Map.of());
        }
        if (metadataSource == null) {
            throw invalid("media.metadata_source", "required", Map.of());
        }
        if (durationMs != null && (durationMs < 0 || durationMs > MAX_DURATION_MS)) {
            throw invalid("media.duration_ms", "out_of_range",
                    Map.of("min", 0, "max", MAX_DURATION_MS));
        }
        if (width != null && (width < 1 || width > MAX_DIMENSION)) {
            throw invalid("media.width", "out_of_range",
                    Map.of("min", 1, "max", MAX_DIMENSION));
        }
        if (height != null && (height < 1 || height > MAX_DIMENSION)) {
            throw invalid("media.height", "out_of_range",
                    Map.of("min", 1, "max", MAX_DIMENSION));
        }
        if (year != null && !year.matches("^[0-9]{4}$")) {
            throw invalid("media.year", "expected_four_digits", Map.of());
        }
    }

    /** Validates and normalizes a client supplied object. Null object -> no metadata. */
    public static MediaMetadata sanitize(String kind, Long durationMs, Integer width,
                                         Integer height, String title, String artist,
                                         String album, String year, String genre,
                                         String artworkUrl, String metadataSource) {
        return new MediaMetadata(parseKind(kind), durationMs, width, height,
                text(title, "media.title", MAX_TITLE_LENGTH),
                text(artist, "media.artist", MAX_ARTIST_LENGTH),
                text(album, "media.album", MAX_ALBUM_LENGTH),
                text(year, "media.year", MAX_YEAR_LENGTH),
                text(genre, "media.genre", MAX_GENRE_LENGTH),
                artwork(artworkUrl), parseSource(metadataSource));
    }

    /**
     * Server-extracted audio metadata (#97). The values come from {@code AudioMetadataParser},
     * which already sanitizes text and bounds duration; the artwork URL is produced by the
     * server itself (never a tag value), so host restrictions do not apply. It is still
     * absolute http(s), control-free and bounded, and the server never fetches it.
     */
    public static MediaMetadata serverAudio(Long durationMs, String title, String artist,
                                            String album, String year, String genre,
                                            String artworkUrl) {
        return new MediaMetadata(MediaKind.AUDIO, clampDuration(durationMs), null, null,
                text(title, "media.title", MAX_TITLE_LENGTH),
                text(artist, "media.artist", MAX_ARTIST_LENGTH),
                text(album, "media.album", MAX_ALBUM_LENGTH),
                text(year, "media.year", MAX_YEAR_LENGTH),
                text(genre, "media.genre", MAX_GENRE_LENGTH),
                serverArtwork(artworkUrl), MediaMetadataSource.SERVER);
    }

    /**
     * Enforces the MIME/kind contract and the voice rules. Called by the upload init after
     * the general file-type allowlist and before any quota reservation.
     */
    public void assertCompatibleWith(String mime) {
        String normalized = normalizeMime(mime);
        if (normalized != null && VOICE_MIME.contains(normalized)) {
            if (kind != MediaKind.AUDIO) {
                throw invalid("media.kind", "voice_requires_audio", Map.of("mime", normalized));
            }
            if (durationMs == null || durationMs < 1) {
                throw invalid("media.duration_ms", "required_for_voice",
                        Map.of("mime", normalized));
            }
            if (durationMs > MAX_VOICE_DURATION_MS) {
                throw invalid("media.duration_ms", "voice_too_long",
                        Map.of("max", MAX_VOICE_DURATION_MS));
            }
        }
        switch (kind) {
            case AUDIO -> {
                if (normalized == null) {
                    throw invalid("media.kind", "mime_required", Map.of());
                }
                if (!normalized.startsWith("audio/")) {
                    throw invalid("media.kind", "mime_kind_mismatch",
                            Map.of("kind", kind.name(), "mime", normalized));
                }
                if (!AUDIO_ALLOWED.contains(normalized)) {
                    throw new UnsupportedFileTypeException(normalized, AUDIO_ALLOWED);
                }
            }
            case VIDEO -> {
                if (normalized == null || !normalized.startsWith("video/")) {
                    throw invalid("media.kind", "mime_kind_mismatch", Map.of("kind",
                            kind.name(), "mime", normalized == null ? "" : normalized));
                }
            }
            case IMAGE -> {
                if (normalized == null || !normalized.startsWith("image/")) {
                    throw invalid("media.kind", "mime_kind_mismatch", Map.of("kind",
                            kind.name(), "mime", normalized == null ? "" : normalized));
                }
            }
            case FILE -> {
                // A generic file may carry any already-allowlisted MIME.
            }
        }
    }

    /** {@code audio/webm}/{@code audio/ogg} are voice recordings and require a duration. */
    public static boolean isVoiceMime(String mime) {
        String normalized = normalizeMime(mime);
        return normalized != null && VOICE_MIME.contains(normalized);
    }

    /** Stable jsonb shape: enum names and snake_case keys, null properties omitted. */
    public Map<String, Object> toMap() {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("kind", kind.name());
        map.put("metadata_source", metadataSource.name());
        if (durationMs != null) {
            map.put("duration_ms", durationMs);
        }
        if (width != null) {
            map.put("width", width);
        }
        if (height != null) {
            map.put("height", height);
        }
        if (title != null) {
            map.put("title", title);
        }
        if (artist != null) {
            map.put("artist", artist);
        }
        if (album != null) {
            map.put("album", album);
        }
        if (year != null) {
            map.put("year", year);
        }
        if (genre != null) {
            map.put("genre", genre);
        }
        if (artworkUrl != null) {
            map.put("artwork_url", artworkUrl);
        }
        return map;
    }

    /**
     * Reads a persisted jsonb object. Fail-closed: a malformed row is surfaced as "no
     * metadata" instead of breaking message listing (the DB check prevents new bad rows).
     */
    public static MediaMetadata fromMap(Map<String, Object> map) {
        if (map == null || map.isEmpty()) {
            return null;
        }
        try {
            return new MediaMetadata(parseKind(string(map.get("kind"))),
                    number(map.get("duration_ms")), integer(map.get("width")),
                    integer(map.get("height")),
                    text(string(map.get("title")), "media.title", MAX_TITLE_LENGTH),
                    text(string(map.get("artist")), "media.artist", MAX_ARTIST_LENGTH),
                    text(string(map.get("album")), "media.album", MAX_ALBUM_LENGTH),
                    text(string(map.get("year")), "media.year", MAX_YEAR_LENGTH),
                    text(string(map.get("genre")), "media.genre", MAX_GENRE_LENGTH),
                    // Persisted values were validated at write time (including server-built
                    // artwork URLs); read them with the server-side URL policy so a private
                    // origin configured for artwork is not dropped on the next read.
                    storedArtwork(string(map.get("artwork_url"))),
                    parseSource(string(map.get("metadata_source"))));
        } catch (RuntimeException ex) {
            return null;
        }
    }

    private static MediaKind parseKind(String value) {
        String normalized = requiredEnum(value, "media.kind");
        try {
            return MediaKind.valueOf(normalized);
        } catch (IllegalArgumentException ex) {
            throw invalid("media.kind", "unknown", Map.of("allowed", "AUDIO,VIDEO,IMAGE,FILE"));
        }
    }

    private static MediaMetadataSource parseSource(String value) {
        String normalized = requiredEnum(value, "media.metadata_source");
        try {
            return MediaMetadataSource.valueOf(normalized);
        } catch (IllegalArgumentException ex) {
            throw invalid("media.metadata_source", "unknown",
                    Map.of("allowed", "ID3,SERVER,CLIENT,NONE"));
        }
    }

    private static String requiredEnum(String value, String field) {
        if (value == null || value.isBlank()) {
            throw invalid(field, "required", Map.of());
        }
        return value.strip().toUpperCase(Locale.ROOT);
    }

    private static String text(String value, String field, int maxLength) {
        if (value == null) {
            return null;
        }
        String normalized = value.strip();
        if (normalized.isEmpty()) {
            return null;
        }
        if (normalized.length() > maxLength) {
            throw invalid(field, "too_long", Map.of("max", maxLength));
        }
        for (int i = 0; i < normalized.length(); i++) {
            char c = normalized.charAt(i);
            if (Character.isISOControl(c) || isBidiControl(c)) {
                throw invalid(field, "control_character", Map.of());
            }
            if (c == '<' || c == '>') {
                throw invalid(field, "html_forbidden", Map.of());
            }
        }
        return normalized;
    }

    private static boolean isBidiControl(char c) {
        return (c >= '\u202A' && c <= '\u202E')
                || (c >= '\u2066' && c <= '\u2069')
                || c == '\u200E' || c == '\u200F';
    }

    private static Long clampDuration(Long durationMs) {
        if (durationMs == null || durationMs < 1) {
            return null;
        }
        return Math.min(durationMs, MAX_DURATION_MS);
    }

    /**
     * Safe artwork policy for untrusted client input: absolute http(s), hostname only. The
     * server never resolves or fetches the URL (no server-side SSRF); rejecting IP
     * literals/local names also keeps the browser-rendered card from being pointed at an
     * intranet address by a tag payload.
     */
    private static String artwork(String value) {
        return absoluteArtwork(value, true);
    }

    /**
     * Artwork URL produced by the server (#97): the origin comes from configuration, not from
     * a tag or a client payload, so local/private origins are allowed (for example a local
     * dev API before a reverse proxy is configured). Scheme/credentials/control-character
     * checks are identical to the client policy.
     */
    private static String serverArtwork(String value) {
        return absoluteArtwork(value, false);
    }

    /**
     * Persisted artwork URL. Rows are written only by the two policies above; reading must not
     * drop a server-built local URL. The strict host policy is still applied to every
     * client-supplied value at write time.
     */
    private static String storedArtwork(String value) {
        return absoluteArtwork(value, false);
    }

    private static String absoluteArtwork(String value, boolean rejectLocalHosts) {
        if (value == null) {
            return null;
        }
        String normalized = value.strip();
        if (normalized.isEmpty()) {
            return null;
        }
        if (normalized.length() > MAX_ARTWORK_URL_LENGTH) {
            throw invalid("media.artwork_url", "too_long",
                    Map.of("max", MAX_ARTWORK_URL_LENGTH));
        }
        for (int i = 0; i < normalized.length(); i++) {
            char c = normalized.charAt(i);
            if (Character.isISOControl(c) || isBidiControl(c) || c == '<' || c == '>') {
                throw invalid("media.artwork_url", "unsafe_character", Map.of());
            }
        }
        URI uri;
        try {
            uri = new URI(normalized);
        } catch (URISyntaxException ex) {
            throw invalid("media.artwork_url", "malformed", Map.of());
        }
        if (!uri.isAbsolute()) {
            throw invalid("media.artwork_url", "absolute_required", Map.of());
        }
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        if (!"https".equals(scheme) && !"http".equals(scheme)) {
            throw invalid("media.artwork_url", "scheme_not_allowed",
                    Map.of("allowed", "http,https"));
        }
        if (uri.getRawUserInfo() != null) {
            throw invalid("media.artwork_url", "credentials_forbidden", Map.of());
        }
        String host = uri.getHost();
        if (host == null || host.isBlank()) {
            throw invalid("media.artwork_url", "host_required", Map.of());
        }
        if (rejectLocalHosts) {
            String normalizedHost = host.toLowerCase(Locale.ROOT);
            while (normalizedHost.endsWith(".")) {
                normalizedHost = normalizedHost.substring(0, normalizedHost.length() - 1);
            }
            if (isForbiddenHost(normalizedHost)) {
                throw invalid("media.artwork_url", "host_not_allowed", Map.of());
            }
        }
        return normalized;
    }

    private static boolean isForbiddenHost(String host) {
        if (host.isEmpty() || "localhost".equals(host) || host.endsWith(".localhost")
                || host.endsWith(".local") || host.endsWith(".internal")
                || host.endsWith(".home.arpa") || "metadata.google.internal".equals(host)) {
            return true;
        }
        // Reject every IP literal (IPv4 dotted/octal/decimal and IPv6 in URI bracket form).
        // Artwork is a browser-rendered URL, so this also removes the intranet pivot class.
        if (host.startsWith("[") || host.indexOf(':') >= 0) {
            return true;
        }
        if (host.matches("^[0-9.]+$") || host.matches("^0x[0-9a-f]+$")) {
            return true;
        }
        return false;
    }

    /** Same normalization as the file type policy: trim, lower-case, drop parameters. */
    public static String normalizeMime(String mime) {
        if (mime == null || mime.isBlank()) {
            return null;
        }
        String value = mime.strip().toLowerCase(Locale.ROOT);
        int params = value.indexOf(';');
        return params >= 0 ? value.substring(0, params).strip() : value;
    }

    private static String string(Object value) {
        return value instanceof String text ? text : null;
    }

    private static Long number(Object value) {
        return value instanceof Number number ? number.longValue() : null;
    }

    private static Integer integer(Object value) {
        return value instanceof Number number ? number.intValue() : null;
    }

    private static MediaMetadataInvalidException invalid(String field, String reason,
                                                         Map<String, Object> extra) {
        return new MediaMetadataInvalidException(field, reason, extra);
    }
}
