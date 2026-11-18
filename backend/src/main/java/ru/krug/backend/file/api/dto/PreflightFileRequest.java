package ru.krug.backend.file.api.dto;

public record PreflightFileRequest(String name, Long size, String mime, String sha256) {

    public long sizeOrZero() {
        return size == null ? 0 : size;
    }
}
