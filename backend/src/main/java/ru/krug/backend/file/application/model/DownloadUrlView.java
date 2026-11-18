package ru.krug.backend.file.application.model;

import java.time.Instant;

public record DownloadUrlView(String url, Instant expiresAt, long sizeBytes, String sha256) {
}
