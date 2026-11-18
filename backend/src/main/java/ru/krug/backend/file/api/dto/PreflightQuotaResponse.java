package ru.krug.backend.file.api.dto;

public record PreflightQuotaResponse(long used, long reserved, long limit) {
}
