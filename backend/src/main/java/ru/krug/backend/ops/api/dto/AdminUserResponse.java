package ru.krug.backend.ops.api.dto;

import java.time.Instant;
import java.util.UUID;

import com.fasterxml.jackson.annotation.JsonProperty;

/** Response DTO for one admin user row (contract {@code AdminUser}). */
public record AdminUserResponse(
        UUID id,
        String email,
        String displayName,
        @JsonProperty("is_platform_admin") boolean platformAdmin,
        String status,
        long workspacesCount,
        long chatsCount,
        long storageUsedBytes,
        Instant createdAt) {
}
