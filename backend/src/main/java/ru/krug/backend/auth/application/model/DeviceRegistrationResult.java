package ru.krug.backend.auth.application.model;

import java.util.UUID;

public record DeviceRegistrationResult(int status, DeviceView device, boolean replay) {
}
