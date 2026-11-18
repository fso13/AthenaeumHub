package ru.krug.backend.ops.application.model;

/** Counts returned by one retention run (after all batches). */
public record RetentionReport(int idempotencyKeys, int outbox) {
}
