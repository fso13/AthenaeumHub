package ru.krug.backend.file.api.dto;

public record UploadPartResponse(int partNo, boolean received, String etag, long sizeBytes) {
}
