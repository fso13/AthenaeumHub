package ru.krug.backend.auth.api.dto;

import java.util.List;
import java.util.UUID;

public record KeyClaimRequest(UUID chatId, List<DeviceRef> devices) {

    public record DeviceRef(UUID deviceId, UUID userId) {
    }
}
