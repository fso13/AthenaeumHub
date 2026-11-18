package ru.krug.backend.auth.application.usecase;

import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.auth.application.port.DeviceBindingPort;
import ru.krug.backend.auth.domain.repository.DeviceRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.TenantContext;

@Service
public class DeviceBindingService implements DeviceBindingPort {

    private final TenantContext tenantContext;
    private final DeviceRepository deviceRepository;

    public DeviceBindingService(TenantContext tenantContext, DeviceRepository deviceRepository) {
        this.tenantContext = tenantContext;
        this.deviceRepository = deviceRepository;
    }

    @Override
    @Transactional(readOnly = true)
    public boolean isActiveDeviceOfUser(UUID deviceId, UUID userId) {
        tenantContext.activate(new Principal(userId, deviceId, null, "device-binding"));
        return deviceRepository.isActiveDeviceOfUser(deviceId, userId);
    }
}
