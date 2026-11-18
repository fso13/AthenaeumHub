package ru.krug.backend.auth.application.command;

public record RegisterDeviceCommand(String name, String platform, String appVersion,
                                    DeviceKeyInput keys) {

    /** Legacy three-field command (no keys); kept for existing callers/tests. */
    public RegisterDeviceCommand(String name, String platform, String appVersion) {
        this(name, platform, appVersion, DeviceKeyInput.legacy());
    }

    public boolean hasKeys() {
        return keys != null && keys.anyFieldPresent();
    }
}
