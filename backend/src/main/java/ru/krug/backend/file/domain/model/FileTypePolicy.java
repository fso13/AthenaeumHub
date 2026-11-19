package ru.krug.backend.file.domain.model;

import java.util.List;
import java.util.Locale;
import java.util.Set;

import ru.krug.backend.shared.domain.model.AllowedFileExtensions;

/**
 * Managed file type policy. Two independent gates are applied, in this order:
 *
 * <ol>
 *   <li><b>Dangerous block</b> — executable/script extensions and active-content MIME
 *       types are rejected outright and can never be re-enabled by configuration.</li>
 *   <li><b>Runtime allowlist</b> — the extension must be present in the installation's
 *       {@code allowed_file_extensions} setting, and the MIME (when supplied) must be in
 *       the managed MIME allowlist. An unknown extension is {@code UNSUPPORTED} (415), so
 *       an admin can narrow or extend the set without a restart.</li>
 * </ol>
 *
 * <p>M4A is first-class: both {@code audio/mp4} and {@code audio/x-m4a} are accepted and
 * {@code m4a} is part of the default allowlist.
 */
public final class FileTypePolicy {

    public enum Verdict {
        ALLOWED,
        UNSUPPORTED,
        DANGEROUS
    }

    /** Human-readable examples used in the 415 error details. */
    private static final List<String> ALLOWED_EXAMPLES = List.of(
            "image/*", "audio/*", "video/*", "application/pdf", "text/plain", "text/csv",
            "application/zip", "application/json", "application/octet-stream",
            "application/vnd.openxmlformats-officedocument.*", "application/vnd.ms-*");

    private static final Set<String> DANGEROUS_MIME = Set.of(
            "application/x-msdownload",
            "application/x-msdos-program",
            "application/vnd.microsoft.portable-executable",
            "application/x-executable",
            "application/x-sh",
            "application/x-shellscript",
            "application/x-bat",
            "application/x-msi",
            "application/java-archive",
            "application/x-javascript",
            "application/javascript",
            "text/javascript",
            "text/html",
            "application/xhtml+xml",
            "image/svg+xml");

    private static final Set<String> EXACT_ALLOWED = Set.of(
            "application/pdf",
            "application/zip",
            "application/x-zip-compressed",
            "application/gzip",
            "application/x-gzip",
            "application/x-7z-compressed",
            "application/x-rar-compressed",
            "application/x-tar",
            "application/json",
            "application/xml",
            "text/xml",
            "application/rtf",
            "text/plain",
            "text/csv",
            "application/msword",
            "application/vnd.ms-excel",
            "application/vnd.ms-powerpoint",
            "application/octet-stream",
            // D1: explicit M4A spellings (audio/* already covered them, but the contract
            // now names them so a future narrowing cannot silently drop M4A).
            "audio/mp4",
            "audio/x-m4a");

    private FileTypePolicy() {
    }

    /** Policy used by domain tests/back-compat callers: installation defaults. */
    public static Verdict check(String filename, String mime) {
        return check(filename, mime, AllowedFileExtensions.defaults());
    }

    /**
     * Runtime policy check. {@code allowedExtensions} is the cached installation setting, so
     * an admin change applies to the next upload without a restart.
     */
    public static Verdict check(String filename, String mime,
                                AllowedFileExtensions allowedExtensions) {
        AllowedFileExtensions allowed = allowedExtensions == null
                ? AllowedFileExtensions.defaults() : allowedExtensions;
        String normalizedMime = normalize(mime);
        String extension = extension(filename);

        // Never weaken the dangerous block, even if a malformed/corrupted setting somehow
        // contains one of these values.
        if (AllowedFileExtensions.DANGEROUS_EXTENSIONS.contains(extension)) {
            return Verdict.DANGEROUS;
        }
        if (normalizedMime != null && DANGEROUS_MIME.contains(normalizedMime)) {
            return Verdict.DANGEROUS;
        }

        // No MIME supplied: the extension is the only signal, so it must be allowlisted.
        if (normalizedMime == null) {
            return allowed.allows(extension) ? Verdict.ALLOWED : Verdict.UNSUPPORTED;
        }

        // A non-empty unknown extension is rejected even when the MIME looks supported.
        // A filename without an extension falls back to the MIME allowlist below.
        if (!extension.isEmpty() && !allowed.allows(extension)) {
            return Verdict.UNSUPPORTED;
        }

        if (EXACT_ALLOWED.contains(normalizedMime)) {
            return Verdict.ALLOWED;
        }
        if (normalizedMime.startsWith("image/") || normalizedMime.startsWith("audio/")
                || normalizedMime.startsWith("video/")) {
            return Verdict.ALLOWED;
        }
        if (normalizedMime.startsWith("application/vnd.openxmlformats-officedocument.")
                || normalizedMime.startsWith("application/vnd.oasis.opendocument.")
                || normalizedMime.startsWith("application/vnd.ms-")) {
            return Verdict.ALLOWED;
        }
        return Verdict.UNSUPPORTED;
    }

    public static List<String> allowedExamples() {
        return ALLOWED_EXAMPLES;
    }

    /** Extension of a filename, lower-cased; empty when absent or trailing-dot. */
    public static String extensionOf(String filename) {
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

    private static String normalize(String mime) {
        if (mime == null || mime.isBlank()) {
            return null;
        }
        String value = mime.trim().toLowerCase(Locale.ROOT);
        int params = value.indexOf(';');
        return params >= 0 ? value.substring(0, params).trim() : value;
    }

    private static String extension(String filename) {
        return extensionOf(filename);
    }
}
