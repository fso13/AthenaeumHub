package ru.krug.backend.file.application.service;

import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Pattern;

import ru.krug.backend.file.application.model.FilePageCursor;
import ru.krug.backend.file.domain.model.MediaKind;
import ru.krug.backend.file.domain.model.ScanStatus;
import ru.krug.backend.shared.error.DomainException;

/**
 * Validation/normalization shared by the file-center query: limit 1..100 (default 50), a
 * literal case-insensitive substring search, exact MIME/extension filters, closed
 * kind/scan-status enums and an opaque workspace-bound cursor.
 *
 * <p>Every value is bound as a JDBC parameter; the normalization here is about rejecting
 * nonsense early and keeping the SQL branches predictable, not about escaping.
 */
public final class FileCenterRequests {

    public static final int DEFAULT_LIMIT = 50;
    public static final int MAX_LIMIT = 100;
    public static final int MAX_QUERY_LENGTH = 200;
    public static final int MAX_MIME_LENGTH = 128;

    /** MIME type shape (type "/" subtype), each part bounded and HTML/space-free. */
    private static final Pattern MIME =
            Pattern.compile("^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$");

    /** A lowercase extension without the dot; the allowlist itself is managed elsewhere. */
    private static final Pattern EXTENSION = Pattern.compile("^[a-z0-9]{1,10}$");

    private FileCenterRequests() {
    }

    public static int limit(Integer requested) {
        int limit = requested == null ? DEFAULT_LIMIT : requested;
        if (limit < 1 || limit > MAX_LIMIT) {
            throw DomainException.badRequest("limit must be between 1 and " + MAX_LIMIT,
                    Map.of("field", "limit", "min", 1, "max", MAX_LIMIT));
        }
        return limit;
    }

    /** Literal substring search; an over-long query is rejected instead of truncated. */
    public static String query(String raw) {
        if (raw == null) {
            return null;
        }
        String normalized = raw.strip();
        if (normalized.length() > MAX_QUERY_LENGTH) {
            throw DomainException.badRequest(
                    "query must be at most " + MAX_QUERY_LENGTH + " characters",
                    Map.of("field", "query", "max", MAX_QUERY_LENGTH));
        }
        return normalized.isEmpty() ? null : normalized;
    }

    public static String kind(String raw) {
        String normalized = enumValue(raw);
        if (normalized == null) {
            return null;
        }
        try {
            return MediaKind.valueOf(normalized).name();
        } catch (IllegalArgumentException ex) {
            throw DomainException.badRequest("kind is invalid", Map.of("field", "kind",
                    "allowed", "IMAGE,VIDEO,AUDIO,FILE"));
        }
    }

    public static String scanStatus(String raw) {
        String normalized = enumValue(raw);
        if (normalized == null) {
            return null;
        }
        try {
            return ScanStatus.valueOf(normalized).name();
        } catch (IllegalArgumentException ex) {
            throw DomainException.badRequest("scan_status is invalid", Map.of("field",
                    "scan_status", "allowed", "PENDING,CLEAN,INFECTED,FAILED,SKIPPED"));
        }
    }

    /** Exact MIME filter, case-insensitive. */
    public static String mime(String raw) {
        if (raw == null) {
            return null;
        }
        String normalized = raw.strip().toLowerCase(Locale.ROOT);
        if (normalized.isEmpty()) {
            return null;
        }
        if (normalized.length() > MAX_MIME_LENGTH || !MIME.matcher(normalized).matches()) {
            throw DomainException.badRequest("mime is invalid",
                    Map.of("field", "mime", "max", MAX_MIME_LENGTH));
        }
        return normalized;
    }

    /** Extension filter without the leading dot, lowercase (for example {@code pdf}). */
    public static String extension(String raw) {
        if (raw == null) {
            return null;
        }
        String normalized = raw.strip().toLowerCase(Locale.ROOT);
        while (normalized.startsWith(".")) {
            normalized = normalized.substring(1);
        }
        if (normalized.isEmpty()) {
            return null;
        }
        if (!EXTENSION.matcher(normalized).matches()) {
            throw DomainException.badRequest("extension is invalid",
                    Map.of("field", "extension", "pattern", "^[a-z0-9]{1,10}$"));
        }
        return normalized;
    }

    public static FilePageCursor cursor(String raw, UUID workspaceId) {
        return raw == null || raw.isBlank() ? null : FilePageCursor.decode(raw, workspaceId);
    }

    private static String enumValue(String raw) {
        if (raw == null) {
            return null;
        }
        String normalized = raw.strip();
        if (normalized.isEmpty()) {
            return null;
        }
        return normalized.toUpperCase(Locale.ROOT);
    }
}
