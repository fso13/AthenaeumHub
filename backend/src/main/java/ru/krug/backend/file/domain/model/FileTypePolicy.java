package ru.krug.backend.file.domain.model;

import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Managed file type policy. This is deliberately an allowlist: an unknown MIME type is
 * unsupported, executable/script types are blocked outright, and SVG/HTML are blocked
 * because they can carry active content into the web client.
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

    private static final Set<String> DANGEROUS_EXT = Set.of(
            "exe", "bat", "cmd", "com", "scr", "pif", "msi", "ps1", "sh", "bash", "vbs",
            "vbe", "js", "jse", "wsf", "wsh", "dll", "sys", "apk", "jar", "app", "deb",
            "rpm", "hta", "cpl", "lnk");

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
            "application/octet-stream");

    private FileTypePolicy() {
    }

    public static Verdict check(String filename, String mime) {
        String normalizedMime = normalize(mime);
        String extension = extension(filename);
        if (DANGEROUS_EXT.contains(extension)) {
            return Verdict.DANGEROUS;
        }
        if (normalizedMime == null) {
            // No MIME supplied: the extension already passed the dangerous check.
            return Verdict.ALLOWED;
        }
        if (DANGEROUS_MIME.contains(normalizedMime)) {
            return Verdict.DANGEROUS;
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

    private static String normalize(String mime) {
        if (mime == null || mime.isBlank()) {
            return null;
        }
        String value = mime.trim().toLowerCase(Locale.ROOT);
        int params = value.indexOf(';');
        return params >= 0 ? value.substring(0, params).trim() : value;
    }

    private static String extension(String filename) {
        if (filename == null) {
            return "";
        }
        int dot = filename.lastIndexOf('.');
        if (dot < 0 || dot == filename.length() - 1) {
            return "";
        }
        return filename.substring(dot + 1).toLowerCase(Locale.ROOT);
    }
}
