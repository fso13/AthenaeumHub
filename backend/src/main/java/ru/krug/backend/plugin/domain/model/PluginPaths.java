package ru.krug.backend.plugin.domain.model;

import java.util.regex.Pattern;

/**
 * Path rules for external plugin packages. A package is a flat archive of static files:
 * paths are always relative, forward-slash separated, ASCII-only and never contain
 * {@code .}/{@code ..} segments. Enforcing the grammar at parse time makes traversal
 * impossible by construction, even before the exact-match database lookup on serving.
 */
public final class PluginPaths {

    public static final int MAX_PATH_LENGTH = 512;
    public static final int MAX_SEGMENTS = 16;
    public static final int MAX_SEGMENT_LENGTH = 128;

    private static final Pattern SEGMENT =
            Pattern.compile("[A-Za-z0-9][A-Za-z0-9._-]{0,127}");

    private PluginPaths() {
    }

    /**
     * Validates a relative asset path (for example {@code assets/app.js}) and returns it
     * unchanged. A leading slash, backslash, empty segment, {@code .}/{@code ..} or a
     * character outside the documented grammar is rejected.
     */
    public static String requireAssetPath(String raw, String field) {
        if (raw == null || raw.isEmpty()) {
            throw invalid(field, "must not be empty");
        }
        if (raw.length() > MAX_PATH_LENGTH) {
            throw invalid(field, "is too long");
        }
        if (raw.startsWith("/") || raw.endsWith("/")) {
            throw invalid(field, "must be a relative file path");
        }
        if (raw.indexOf('\\') >= 0 || raw.indexOf('\0') >= 0) {
            throw invalid(field, "contains a forbidden character");
        }
        String[] segments = raw.split("/", -1);
        if (segments.length > MAX_SEGMENTS) {
            throw invalid(field, "has too many path segments");
        }
        for (String segment : segments) {
            if (segment.isEmpty() || ".".equals(segment) || "..".equals(segment)) {
                throw invalid(field, "contains an unsafe path segment");
            }
            if (segment.length() > MAX_SEGMENT_LENGTH || !SEGMENT.matcher(segment).matches()) {
                throw invalid(field, "contains an unsupported path segment");
            }
        }
        return raw;
    }

    /** The package entry must be a relative {@code .html} file. */
    public static String requireEntry(String raw) {
        String entry = requireAssetPath(raw, "entry");
        if (!entry.toLowerCase(java.util.Locale.ROOT).endsWith(".html")) {
            throw invalid("entry", "must point to an .html file");
        }
        return entry;
    }

    /**
     * Normalises a path captured by the HTTP routing layer ({@code {*path}} carries a
     * leading slash). Unsafe input is rejected with {@link IllegalArgumentException}; the
     * controller maps that to a hidden 404 rather than leaking traversal details.
     */
    public static String normalizeRequestPath(String raw) {
        if (raw == null) {
            throw invalid("path", "must not be empty");
        }
        String value = raw.startsWith("/") ? raw.substring(1) : raw;
        return requireAssetPath(value, "path");
    }

    public static String extension(String path) {
        int slash = path.lastIndexOf('/');
        int dot = path.lastIndexOf('.');
        if (dot <= slash || dot == path.length() - 1) {
            return "";
        }
        return path.substring(dot + 1).toLowerCase(java.util.Locale.ROOT);
    }

    private static IllegalArgumentException invalid(String field, String reason) {
        return new IllegalArgumentException(field + " " + reason);
    }
}
