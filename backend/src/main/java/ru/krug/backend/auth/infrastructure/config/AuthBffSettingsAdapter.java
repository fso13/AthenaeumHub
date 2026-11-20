package ru.krug.backend.auth.infrastructure.config;

import java.time.Duration;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

import ru.krug.backend.auth.application.port.AuthBffSettings;
import ru.krug.backend.ops.application.port.SystemSettingsPort;

/**
 * Adapter from the Auth BFF configuration record to the application-facing port. Runtime
 * {@code registration_open} from {@code ops.system_settings} is ANDed with the environment
 * switch: either one can close registration.
 */
@Component
public class AuthBffSettingsAdapter implements AuthBffSettings {

    private final AuthBffProperties properties;
    private final SystemSettingsPort systemSettings;

    /** Test/back-compat constructor: no database settings, environment switch only. */
    public AuthBffSettingsAdapter(AuthBffProperties properties) {
        this(properties, null);
    }

    @Autowired
    public AuthBffSettingsAdapter(AuthBffProperties properties,
                                  SystemSettingsPort systemSettings) {
        this.properties = properties;
        this.systemSettings = systemSettings;
    }

    @Override
    public boolean registrationEnabled() {
        return properties.registrationEnabled()
                && (systemSettings == null || systemSettings.current().registrationOpen());
    }

    @Override
    public boolean trustForwardedFor() {
        return properties.trustForwardedFor();
    }

    @Override
    public Duration codeExpiry() {
        return properties.code().expiry();
    }

    @Override
    public Duration resendCooldown() {
        return properties.code().resendCooldown();
    }

    @Override
    public int maxAttempts() {
        return properties.code().maxAttempts();
    }

    @Override
    public Duration pendingSessionTtl() {
        return properties.pendingSessionTtl();
    }

    @Override
    public int cleanupBatchSize() {
        return properties.cleanup().batchSize();
    }

    @Override
    public Duration cleanupConsumedRetention() {
        return properties.cleanup().consumedRetention();
    }

    @Override
    public Duration twoFactorChallengeTtl() {
        return properties.twoFactor().challengeTtl();
    }

    @Override
    public int twoFactorMaxAttempts() {
        return properties.twoFactor().maxAttempts();
    }

    @Override
    public int twoFactorWindow() {
        return properties.twoFactor().window();
    }

    @Override
    public String twoFactorIssuer() {
        return properties.twoFactor().issuer();
    }

    @Override
    public boolean requireTwoFactor() {
        // No database settings in unit-test/back-compat construction -> policy defaults off.
        return systemSettings != null && systemSettings.current().requireTwoFactor();
    }
}
