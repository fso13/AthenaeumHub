package ru.krug.backend.room.api.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/** {@code PATCH /workspaces/{workspaceId}/rooms/{roomId}}; name is trimmed to 1..120 chars. */
public record UpdateRoomRequest(
        @NotBlank @Size(max = 120) String name) {
}
