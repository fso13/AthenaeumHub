package ru.krug.backend.file.api.dto;

import java.time.Instant;

public record DownloadUrlResponse(String url, Instant expiresAt, long sizeBytes, String sha256) {
}
