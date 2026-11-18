package ru.krug.backend.ops.api.dto;

import java.time.Instant;
import java.util.UUID;

public record SessionResponse(
        String accessToken,
        Instant expiresAt,
        UserInfo user,
        DeviceInfo device,
        WorkspaceInfo workspace,
        ChatInfo chat) {

    public record UserInfo(UUID id, String displayName) {
    }

    public record DeviceInfo(UUID id, String platform) {
    }

    public record WorkspaceInfo(UUID id, String name, String securityMode) {
    }

    public record ChatInfo(UUID id, String name, String type) {
    }
}
