package ru.krug.backend.shared.application.model;

import java.util.UUID;

/**
 * Authenticated caller after device binding. {@code deviceId} is null on endpoints where
 * the contract does not require {@code X-Device-Id} and no header was sent.
 */
public record AuthenticatedActor(UUID userId, UUID deviceId) {

    /** Request attribute set by DeviceBindingFilter and read by the API resolver. */
    public static final String REQUEST_ATTRIBUTE = AuthenticatedActor.class.getName();
}
