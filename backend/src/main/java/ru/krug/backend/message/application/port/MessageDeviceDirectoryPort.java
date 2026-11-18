package ru.krug.backend.message.application.port;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

import ru.krug.backend.message.application.model.MessageDeviceView;

/**
 * Public device directory for E2EE fan-out. Only ACTIVE {@code e2ee_capable} devices are
 * candidates; {@link #findDevice} is used to tell a legacy recipient (422
 * E2EE_LEGACY_DEVICE) from an invisible/revoked one (422 UNKNOWN_DEVICE). RLS restricts
 * visibility to own devices and devices of a shared-chat peer.
 */
public interface MessageDeviceDirectoryPort {

    List<MessageDeviceView> activeE2eeDevices(List<UUID> userIds);

    Optional<MessageDeviceView> findDevice(UUID deviceId);
}
