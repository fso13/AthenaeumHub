package ru.krug.backend.ops.api.dto;

/** Response DTO for GET /setup/status (public, secret-free). */
public record SetupStatusResponse(boolean setupRequired, boolean registrationOpen) {
}
