package ru.krug.backend.auth.application.model;

import java.util.List;
import java.util.UUID;

public record ChatKeysView(UUID chatId, String securityMode, Integer keyEpoch,
                           UUID myDeviceId, UUID verifierDeviceId, int verifiedCount,
                           int verifiedByOtherDevicesCount, int devicesTotal,
                           List<DeviceKeyInfoView> devices) {

    public ChatKeysView {
        devices = devices == null ? List.of() : List.copyOf(devices);
    }
}
