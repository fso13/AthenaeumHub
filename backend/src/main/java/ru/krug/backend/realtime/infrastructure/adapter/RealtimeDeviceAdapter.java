package ru.krug.backend.realtime.infrastructure.adapter;

import java.util.UUID;

import org.springframework.stereotype.Component;

import ru.krug.backend.auth.application.port.DeviceBindingPort;
import ru.krug.backend.realtime.application.port.RealtimeDevicePort;

@Component
public class RealtimeDeviceAdapter implements RealtimeDevicePort {

    private final DeviceBindingPort deviceBinding;

    public RealtimeDeviceAdapter(DeviceBindingPort deviceBinding) {
        this.deviceBinding = deviceBinding;
    }

    @Override
    public boolean isActiveDeviceOfUser(UUID deviceId, UUID userId) {
        return deviceBinding.isActiveDeviceOfUser(deviceId, userId);
    }
}
