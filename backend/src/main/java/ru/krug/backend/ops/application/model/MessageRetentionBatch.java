package ru.krug.backend.ops.application.model;

/** Count of messages soft-deleted by one bounded retention batch. */
public record MessageRetentionBatch(int deleted) {
}
