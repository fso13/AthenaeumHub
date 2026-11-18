package ru.krug.backend.ops.application.port;

import ru.krug.backend.ops.application.model.RuntimeSmtpSettings;
import ru.krug.backend.ops.application.model.SystemSettingsView;

/**
 * Published settings port. Other contexts use {@link #current()} for business parameters;
 * only the mail adapter may call {@link #smtp()}, which contains a decrypted secret.
 */
public interface SystemSettingsPort {

    SystemSettingsView current();

    /** Runtime SMTP configuration; the password is plaintext in memory only. */
    RuntimeSmtpSettings smtp();
}
