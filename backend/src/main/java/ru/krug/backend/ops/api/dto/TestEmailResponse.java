package ru.krug.backend.ops.api.dto;

/** Response DTO for POST /admin/settings/test-email. */
public record TestEmailResponse(boolean sent, String to) {
}
