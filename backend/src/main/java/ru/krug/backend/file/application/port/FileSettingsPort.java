package ru.krug.backend.file.application.port;

import java.time.Duration;

import ru.krug.backend.shared.domain.model.AllowedFileExtensions;

/** Read-only file settings, so application code never imports infrastructure config. */
public interface FileSettingsPort {

    Duration uploadTtl();

    Duration downloadTtl();

    /**
     * Installation allowlist from {@code ops.system_settings.allowed_file_extensions}.
     * The ops adapter caches it and invalidates on PATCH, so changes apply without restart.
     */
    AllowedFileExtensions allowedFileExtensions();
}
