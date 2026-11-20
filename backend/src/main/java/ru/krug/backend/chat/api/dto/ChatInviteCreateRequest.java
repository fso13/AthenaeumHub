package ru.krug.backend.chat.api.dto;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;

/**
 * OpenAPI {@code ChatInviteCreateRequest} (#79). All fields are optional and the service
 * applies the defaults (MEMBER, 7 days, unlimited uses). Bean-validation bounds mirror the
 * contract; the service re-validates because a null body is also accepted.
 */
public record ChatInviteCreateRequest(
        String role,
        @Min(1) @Max(1000) Integer maxUses,
        @Min(300) @Max(2592000) Long expiresInSeconds) {
}
