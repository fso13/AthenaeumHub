package ru.krug.backend.file.application.port;

import java.time.Duration;

/** Read-only file TTL settings, so application code never imports infrastructure config. */
public interface FileSettingsPort {

    Duration uploadTtl();

    Duration downloadTtl();
}
