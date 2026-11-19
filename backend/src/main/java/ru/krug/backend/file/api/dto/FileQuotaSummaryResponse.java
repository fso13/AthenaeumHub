package ru.krug.backend.file.api.dto;

/** OpenAPI {@code FileQuotaSummary}: read-only workspace quota snapshot. */
public record FileQuotaSummaryResponse(
        long usedBytes,
        long reservedBytes,
        long storageBytes,
        int percent) {
}
