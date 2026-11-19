package ru.krug.backend.file.application.model;

/** Workspace-level quota snapshot shown in the file-center header. */
public record FileQuotaSummaryView(
        long usedBytes,
        long reservedBytes,
        long storageBytes,
        int percent) {
}
