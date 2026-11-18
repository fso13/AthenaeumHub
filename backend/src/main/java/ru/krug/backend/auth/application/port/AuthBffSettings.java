package ru.krug.backend.auth.application.port;

import java.time.Duration;

/**
 * Application-facing view of the Auth BFF configuration. Implemented in infrastructure by
 * {@code AuthBffSettingsAdapter}; keeps {@code AuthBffProperties} out of the application
 * layer (ArchUnit).
 */
public interface AuthBffSettings {

    boolean registrationEnabled();

    boolean trustForwardedFor();

    Duration codeExpiry();

    Duration resendCooldown();

    int maxAttempts();

    Duration pendingSessionTtl();

    int cleanupBatchSize();

    Duration cleanupConsumedRetention();
}
