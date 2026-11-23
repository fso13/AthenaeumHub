package ru.krug.backend.bot.api.dto;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * Bot metadata. Never contains a bearer token or a token hash.
 *
 * <p>#98: {@code signing_secret} is non-null only in the single PATCH/rotate response that
 * generated the secret; it is omitted otherwise (including every list/read response).</p>
 */
public record BotResponse(
        UUID id,
        UUID workspaceId,
        String name,
        UUID avatarFileId,
        List<String> scopes,
        String status,
        UUID createdBy,
        Instant createdAt,
        Instant updatedAt,
        Instant tokenRotatedAt,
        String eventsUrl,
        List<String> events,
        boolean eventsEnabled,
        boolean hasSigningSecret,
        Instant signingSecretCreatedAt,
        List<BotCommandResponse> commands,
        @JsonInclude(JsonInclude.Include.NON_NULL) String signingSecret) {
}
