package ru.krug.backend.room.api.dto;

import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

/**
 * {@code PATCH /workspaces/{workspaceId}/rooms/{roomId}} (#105/#107). Partial update:
 * {@code name} and/or {@code media_mode}; at least one of them must be present. A provided
 * name is trimmed to 1..120 characters, {@code media_mode} is {@code AUDIO|VIDEO}.
 */
public record UpdateRoomRequest(
        @Size(min = 1, max = 120) String name,
        @Pattern(regexp = "AUDIO|VIDEO") String mediaMode) {
}
