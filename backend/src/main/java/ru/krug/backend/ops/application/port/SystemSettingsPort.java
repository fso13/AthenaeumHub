package ru.krug.backend.ops.application.port;

import ru.krug.backend.ops.application.model.RuntimeSmtpSettings;
import ru.krug.backend.ops.application.model.SystemSettingsView;
import ru.krug.backend.shared.domain.model.AllowedFileExtensions;

/**
 * Published settings port. Other contexts use {@link #current()} for business parameters;
 * only the mail adapter may call {@link #smtp()}, which contains a decrypted secret.
 */
public interface SystemSettingsPort {

    /** Cache name for the runtime file-extension allowlist (evicted on PATCH). */
    String ALLOWED_FILE_EXTENSIONS_CACHE = "system-settings-allowed-file-extensions";

    SystemSettingsView current();

    /**
     * Runtime file-extension allowlist. Cached; the admin update evicts the cache, so the
     * next upload/preflight sees the new value without a process restart.
     */
    AllowedFileExtensions allowedFileExtensions();

    /** Runtime SMTP configuration; the password is plaintext in memory only. */
    RuntimeSmtpSettings smtp();
}
