package ru.krug.backend.auth.application.usecase;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.auth.application.command.DevDeviceCommand;
import ru.krug.backend.auth.application.command.DevUserCommand;
import ru.krug.backend.auth.application.port.AuthProvisioningPort;
import ru.krug.backend.auth.domain.model.Device;
import ru.krug.backend.auth.domain.model.DisplayName;
import ru.krug.backend.auth.domain.model.User;
import ru.krug.backend.auth.domain.repository.DeviceRepository;
import ru.krug.backend.auth.domain.repository.UserRepository;

@Service
public class AuthProvisioningService implements AuthProvisioningPort {

    private final UserRepository userRepository;
    private final DeviceRepository deviceRepository;

    public AuthProvisioningService(UserRepository userRepository,
                                   DeviceRepository deviceRepository) {
        this.userRepository = userRepository;
        this.deviceRepository = deviceRepository;
    }

    @Override
    @Transactional
    public void ensureDevUser(DevUserCommand command) {
        User user = User.createDev(command.userId(), command.email(),
                new DisplayName(command.displayName()), userRepository.claimPlatformAdmin());
        userRepository.save(user);
    }

    @Override
    @Transactional
    public void ensureDevDevice(DevDeviceCommand command) {
        deviceRepository.save(Device.createWeb(command.deviceId(), command.userId()));
    }
}
