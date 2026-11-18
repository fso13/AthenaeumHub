package ru.krug.backend.ops.api.dto;

/** Response DTO for storage dashboard totals (contract {@code AdminStorageTotals}). */
public record AdminStorageTotalsResponse(
        long usedBytes,
        long reservedBytes,
        long objects,
        long attachments) {
}
