package ru.krug.backend.file.api.dto;

public record WorkspaceUsageResponse(long used, long reserved, long limit) {
}
