package ru.krug.backend.message.infrastructure.adapter;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

import org.springframework.stereotype.Component;

import ru.krug.backend.auth.domain.model.Device;
import ru.krug.backend.auth.domain.repository.DeviceRepository;
import ru.krug.backend.message.application.model.MessageDeviceView;
import ru.krug.backend.message.application.port.MessageDeviceDirectoryPort;

/**
 * E2EE device directory over the auth aggregate. RLS decides visibility: own devices
 * ({@code p_devices_self}) and ACTIVE devices of a shared-chat peer
 * ({@code p_devices_chat_peer}). A device outside that set is reported as unknown.
 */
@Component
public class MessageDeviceDirectoryAdapter implements MessageDeviceDirectoryPort {

    private final DeviceRepository deviceRepository;

    public MessageDeviceDirectoryAdapter(DeviceRepository deviceRepository) {
        this.deviceRepository = deviceRepository;
    }

    @Override
    public List<MessageDeviceView> activeE2eeDevices(List<UUID> userIds) {
        return deviceRepository.findActiveByUserIds(userIds).stream()
                .map(MessageDeviceDirectoryAdapter::toView)
                .toList();
    }

    @Override
    public Optional<MessageDeviceView> findDevice(UUID deviceId) {
        if (deviceId == null) {
            return Optional.empty();
        }
        return deviceRepository.findById(deviceId).map(MessageDeviceDirectoryAdapter::toView);
    }

    private static MessageDeviceView toView(Device device) {
        return new MessageDeviceView(device.id(), device.userId(), device.keyGeneration(),
                device.isActive(), device.isE2eeCapable(), device.identitySigningKey(),
                device.identityDhKey());
    }
}
