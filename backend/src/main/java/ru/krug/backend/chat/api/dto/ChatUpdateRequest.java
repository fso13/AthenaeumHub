package ru.krug.backend.chat.api.dto;

import java.util.UUID;

/**
 * {@code PATCH /chats/{chatId}} body (D1-BE3 + P0-2). Absent/null fields are not changed;
 * {@code description: ""} clears the description. Length/plain-text checks are performed in
 * the application layer so violations return a semantic {@code 422} with details.
 *
 * <p>{@code cover_file_id} references an existing CLEAN image attachment of the chat;
 * {@code read_only}, {@code visibility}, {@code join_policy} and {@code rights} are structural
 * channel settings (chat OWNER/ADMIN, GROUP only).</p>
 */
public record ChatUpdateRequest(
        String name,
        String description,
        UUID coverFileId,
        Boolean readOnly,
        String visibility,
        String joinPolicy,
        ChatPermissionsUpdateRequest rights) {
}
