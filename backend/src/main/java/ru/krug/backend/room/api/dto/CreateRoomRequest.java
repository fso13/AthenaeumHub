package ru.krug.backend.room.api.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

/**
 * {@code POST /workspaces/{workspaceId}/rooms} (#105/#107); name is trimmed to 1..120
 * characters, {@code media_mode} is optional and defaults to {@code VIDEO}.
 */
public record CreateRoomRequest(
        @NotBlank @Size(max = 120) String name,
        @Pattern(regexp = "AUDIO|VIDEO") String mediaMode) {
}
