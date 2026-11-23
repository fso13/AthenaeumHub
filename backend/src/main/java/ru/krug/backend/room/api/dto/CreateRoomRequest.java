package ru.krug.backend.room.api.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/** {@code POST /workspaces/{workspaceId}/rooms}; name is trimmed to 1..120 characters. */
public record CreateRoomRequest(
        @NotBlank @Size(max = 120) String name) {
}
