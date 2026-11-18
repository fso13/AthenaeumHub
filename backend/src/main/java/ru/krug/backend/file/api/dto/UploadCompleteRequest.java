package ru.krug.backend.file.api.dto;

public record UploadCompleteRequest(String sha256, Integer partsCount) {
}
