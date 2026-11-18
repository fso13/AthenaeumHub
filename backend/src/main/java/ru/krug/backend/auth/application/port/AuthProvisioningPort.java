package ru.krug.backend.auth.application.port;

import ru.krug.backend.auth.application.command.DevDeviceCommand;
import ru.krug.backend.auth.application.command.DevUserCommand;

/**
 * Published port of the auth context. Dev bootstrap orchestration lives in ops and only
 * sees this interface.
 */
public interface AuthProvisioningPort {

    void ensureDevUser(DevUserCommand command);

    void ensureDevDevice(DevDeviceCommand command);
}
