package ru.krug.backend.ops.application.model;

/** Export format for the bounded platform-audit export. */
public enum AdminExportFormat {
    CSV,
    JSON;

    /** @return null when the value is not a supported format */
    public static AdminExportFormat parse(String raw) {
        if (raw == null) {
            return null;
        }
        String value = raw.strip();
        if (value.isEmpty()) {
            return null;
        }
        for (AdminExportFormat format : values()) {
            if (format.name().equalsIgnoreCase(value)) {
                return format;
            }
        }
        return null;
    }
}
