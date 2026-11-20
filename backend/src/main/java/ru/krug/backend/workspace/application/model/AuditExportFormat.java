package ru.krug.backend.workspace.application.model;

/** Supported workspace audit export encodings. */
public enum AuditExportFormat {
    CSV,
    JSON;

    public static AuditExportFormat parse(String raw) {
        if (raw == null) {
            return null;
        }
        return switch (raw.strip().toLowerCase(java.util.Locale.ROOT)) {
            case "csv" -> CSV;
            case "json" -> JSON;
            default -> null;
        };
    }
}
