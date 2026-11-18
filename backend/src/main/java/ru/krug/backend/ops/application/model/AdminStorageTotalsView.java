package ru.krug.backend.ops.application.model;

/** Storage dashboard totals (sum of the returned rows). Aggregates only. */
public record AdminStorageTotalsView(
        long usedBytes,
        long reservedBytes,
        long objects,
        long attachments) {
}
