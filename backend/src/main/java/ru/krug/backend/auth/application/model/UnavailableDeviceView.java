package ru.krug.backend.auth.application.model;

import java.util.UUID;

public record UnavailableDeviceView(UUID deviceId, String reason) {
}
