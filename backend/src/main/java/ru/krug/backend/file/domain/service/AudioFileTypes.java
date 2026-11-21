package ru.krug.backend.file.domain.service;

import java.util.Locale;
import java.util.Set;

/**
 * Recognises audio uploads for server-side metadata extraction (#97).
 *
 * <p>MIME is the primary signal, but browsers sometimes send {@code application/octet-stream}
 * for a picked file; the extension is then used as a fallback. Video containers are never
 * treated as audio here, even when they contain an audio track.
 */
public final class AudioFileTypes {

    private static final Set<String> AUDIO_EXTENSIONS = Set.of(
            "mp3", "mp2", "m4a", "m4b", "aac", "ogg", "oga", "opus", "flac", "wav", "weba",
            "wma");

    private static final Set<String> VOICE_MIME = Set.of("audio/webm", "audio/ogg");

    private AudioFileTypes() {
    }

    public static boolean isAudio(String mime, String filename) {
        String normalized = normalizeMime(mime);
        if (normalized != null && normalized.startsWith("audio/")) {
            return true;
        }
        return AUDIO_EXTENSIONS.contains(extension(filename));
    }

    /** {@code audio/webm}/{@code audio/ogg} are voice takes: the server cannot parse them. */
    public static boolean isVoice(String mime, String filename) {
        String normalized = normalizeMime(mime);
        if (normalized != null && VOICE_MIME.contains(normalized)) {
            return true;
        }
        String extension = extension(filename);
        return "weba".equals(extension) || "webm".equals(extension);
    }

    public static String normalizeMime(String mime) {
        if (mime == null || mime.isBlank()) {
            return null;
        }
        String value = mime.strip().toLowerCase(Locale.ROOT);
        int params = value.indexOf(';');
        return params >= 0 ? value.substring(0, params).strip() : value;
    }

    public static String extension(String filename) {
        if (filename == null) {
            return "";
        }
        int slash = Math.max(filename.lastIndexOf('/'), filename.lastIndexOf('\\'));
        int dot = filename.lastIndexOf('.');
        if (dot < 0 || dot == filename.length() - 1 || dot < slash) {
            return "";
        }
        return filename.substring(dot + 1).toLowerCase(Locale.ROOT);
    }
}
