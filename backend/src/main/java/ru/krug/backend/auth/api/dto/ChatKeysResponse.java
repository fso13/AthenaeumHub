package ru.krug.backend.auth.api.dto;

import java.util.List;
import java.util.UUID;

public record ChatKeysResponse(
        UUID chatId,
        String securityMode,
        Integer keyEpoch,
        UUID myDeviceId,
        UUID verifierDeviceId,
        int verifiedCount,
        int verifiedByOtherDevicesCount,
        int devicesTotal,
        List<DeviceKeyInfoResponse> devices) {
}
