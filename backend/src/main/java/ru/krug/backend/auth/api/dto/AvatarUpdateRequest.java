package ru.krug.backend.auth.api.dto;

import java.util.UUID;

import jakarta.validation.constraints.NotNull;

/** {@code POST /me/avatar}: reference an existing CLEAN image attachment. */
public record AvatarUpdateRequest(@NotNull UUID fileId) {
}
