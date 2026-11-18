package ru.krug.backend.auth.application.command;

import java.util.UUID;

public record DevDeviceCommand(UUID deviceId, UUID userId) {
}
