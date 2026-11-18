package ru.krug.backend.realtime.application.port;

import java.util.UUID;

/** Published auth port: the device must exist, belong to the user, and be ACTIVE. */
public interface RealtimeDevicePort {

    boolean isActiveDeviceOfUser(UUID deviceId, UUID userId);
}
