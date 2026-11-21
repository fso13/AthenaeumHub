package ru.krug.backend.file.application.port;

import java.time.Duration;

import ru.krug.backend.shared.domain.model.AllowedFileExtensions;

/** Read-only file settings, so application code never imports infrastructure config. */
public interface FileSettingsPort {

    Duration uploadTtl();

    Duration downloadTtl();

    /**
     * Absolute public API origin used to build {@code AttachmentRef.media.artwork_url} for
     * server-extracted covers (#97), for example {@code https://chat.example.com}. Blank means
     * "do not advertise an URL"; the authenticated artwork endpoint still works by attachment
     * id. The server never fetches this URL.
     */
    String artworkBaseUrl();

    /**
     * Installation allowlist from {@code ops.system_settings.allowed_file_extensions}.
     * The ops adapter caches it and invalidates on PATCH, so changes apply without restart.
     */
    AllowedFileExtensions allowedFileExtensions();
}
