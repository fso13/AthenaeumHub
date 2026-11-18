package ru.krug.backend.shared.infrastructure.security;

import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;

import ru.krug.backend.shared.application.model.AuthenticatedActor;

/**
 * Profile-specific device binding. Dev tokens carry a {@code device_id} claim; Keycloak
 * tokens do not, so the Keycloak strategy checks the auth.devices table instead.
 */
public interface DeviceBindingStrategy {

    AuthenticatedActor resolve(JwtAuthenticationToken authentication, String deviceHeader,
                               boolean deviceRequired, String requestId);
}
