package ru.krug.backend.auth.application.port;

import java.util.UUID;

/** Published auth port used by the Keycloak device-binding strategy. */
public interface DeviceBindingPort {

    boolean isActiveDeviceOfUser(UUID deviceId, UUID userId);
}
