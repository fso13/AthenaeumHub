package ru.krug.backend.ops.application.model;

import java.time.Instant;
import java.util.UUID;

/**
 * Application result of the dev bootstrap. API maps it to the contract Session DTO.
 */
public record SessionResult(
        String accessToken,
        Instant expiresAt,
        UserView user,
        DeviceView device,
        WorkspaceView workspace,
        ChatView chat) {

    public record UserView(UUID id, String displayName) {
    }

    public record DeviceView(UUID id, String platform) {
    }

    public record WorkspaceView(UUID id, String name, String securityMode) {
    }

    public record ChatView(UUID id, String name, String type) {
    }
}
