package ru.krug.backend.file.api.dto;

import java.util.UUID;

public record UploadInitRequest(
        UUID chatId,
        String filename,
        Long size,
        String mime,
        String encryptionMode,
        String sha256,
        MediaMetadataRequest media) {

    public long sizeOrZero() {
        return size == null ? 0 : size;
    }
}
