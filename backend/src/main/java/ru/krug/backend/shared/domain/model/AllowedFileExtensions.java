package ru.krug.backend.shared.domain.model;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Installation-level allowlist of file extensions.
 *
 * <p>This is a shared-kernel value object: the file context enforces it at upload init and
 * preflight, while the ops context persists and validates the platform-admin setting. The
 * rules are deliberately strict and fail closed:
 *
 * <ul>
 *   <li>1..100 entries;</li>
 *   <li>each entry is a lower-case extension without a leading dot, matching
 *       {@code [a-z0-9]{1,10}};</li>
 *   <li>duplicates are rejected (case-insensitive after normalization);</li>
 *   <li>known executable/active-content extensions can never be allowlisted.</li>
 * </ul>
 *
 * <p>Input is normalized (trimmed + lower-cased) before validation. An explicit empty list
 * is rejected instead of silently meaning "allow nothing" or "use defaults"; the service
 * layer treats {@code null} as "leave unchanged".
 */
public record AllowedFileExtensions(List<String> values) {

    public static final int MAX_ENTRIES = 100;
    public static final int MAX_EXTENSION_LENGTH = 10;
    public static final String EXTENSION_PATTERN = "[a-z0-9]{1,10}";

    private static final Pattern PATTERN = Pattern.compile("^" + EXTENSION_PATTERN + "$");

    /**
     * Extensions that may never be uploaded as an attachment, whatever MIME the client
     * declares. This list is the canonical dangerous block used by both the file policy and
     * the admin validation; changing it is a security decision.
     */
    public static final Set<String> DANGEROUS_EXTENSIONS = Set.of(
            "exe", "bat", "cmd", "com", "scr", "pif", "msi", "ps1", "sh", "bash", "vbs",
            "vbe", "js", "jse", "wsf", "wsh", "dll", "sys", "apk", "jar", "app", "deb",
            "rpm", "hta", "cpl", "lnk",
            // Active web content: the MIME block already covers text/html and
            // image/svg+xml, but the extension must be safe even when MIME is omitted.
            "html", "htm", "xhtml", "shtml", "svg");

    /**
     * Current safe installation default: the formats the managed file policy already
     * supported, plus M4A (D1) and a few common non-executable document/media formats.
     */
    public static final List<String> DEFAULTS = List.of(
            // images
            "jpg", "jpeg", "png", "gif", "webp", "avif", "bmp", "tif", "tiff", "heic",
            "heif", "ico",
            // audio (M4A is the D1 addition; audio/mp4 and audio/x-m4a are both accepted)
            "mp3", "m4a", "aac", "ogg", "oga", "opus", "flac", "wav", "weba", "wma",
            "aiff", "amr",
            // video
            "mp4", "m4v", "mov", "webm", "ogv", "mkv", "avi", "wmv", "mpg", "mpeg", "3gp",
            // plain text and structured text
            "pdf", "txt", "csv", "tsv", "rtf", "json", "xml", "md", "markdown", "log",
            "yaml", "yml", "toml",
            // office documents
            "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp",
            // archives
            "zip", "gz", "tgz", "tar", "rar", "7z", "bz2", "xz",
            // generic/opaque and assorted safe formats
            "bin", "dat", "fig", "epub", "mobi", "srt", "vtt", "ics", "vcf");

    public AllowedFileExtensions {
        if (values == null) {
            throw new IllegalArgumentException("allowed_file_extensions is required");
        }
        if (values.size() < 1 || values.size() > MAX_ENTRIES) {
            throw new IllegalArgumentException(
                    "allowed_file_extensions must contain between 1 and " + MAX_ENTRIES
                            + " entries");
        }
        LinkedHashSet<String> unique = new LinkedHashSet<>();
        List<String> normalized = new ArrayList<>(values.size());
        for (int i = 0; i < values.size(); i++) {
            String raw = Objects.requireNonNullElse(values.get(i), "").strip()
                    .toLowerCase(Locale.ROOT);
            if (!PATTERN.matcher(raw).matches()) {
                throw new IllegalArgumentException("allowed_file_extensions[" + i
                        + "] must match " + EXTENSION_PATTERN + " (lower-case, no dot)");
            }
            if (DANGEROUS_EXTENSIONS.contains(raw)) {
                throw new IllegalArgumentException("allowed_file_extensions[" + i
                        + "] is a blocked dangerous extension");
            }
            if (!unique.add(raw)) {
                throw new IllegalArgumentException("allowed_file_extensions[" + i
                        + "] duplicates an earlier entry");
            }
            normalized.add(raw);
        }
        values = List.copyOf(normalized);
    }

    public static AllowedFileExtensions defaults() {
        return new AllowedFileExtensions(DEFAULTS);
    }

    /** Builds a validated/normalized list from an admin request. */
    public static AllowedFileExtensions of(List<String> values) {
        return new AllowedFileExtensions(values);
    }

    public boolean allows(String extension) {
        return extension != null && values.contains(extension);
    }

    public boolean isEmpty() {
        return values.isEmpty();
    }
}
