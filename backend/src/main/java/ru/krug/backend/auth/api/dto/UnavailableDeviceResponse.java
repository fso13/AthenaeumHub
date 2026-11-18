package ru.krug.backend.auth.api.dto;

import java.util.UUID;

public record UnavailableDeviceResponse(UUID deviceId, String reason) {
}
