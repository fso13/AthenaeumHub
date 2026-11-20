package ru.krug.backend.chat.api.dto;

import jakarta.validation.constraints.NotBlank;

/** OpenAPI {@code ChangeChatMemberRoleRequest} (#79). */
public record ChangeChatMemberRoleRequest(@NotBlank String role) {
}
