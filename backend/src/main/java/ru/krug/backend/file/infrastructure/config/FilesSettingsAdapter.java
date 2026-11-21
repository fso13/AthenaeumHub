package ru.krug.backend.file.infrastructure.config;

import java.time.Duration;

import org.springframework.stereotype.Component;

import ru.krug.backend.file.application.port.FileSettingsPort;
import ru.krug.backend.ops.application.port.SystemSettingsPort;
import ru.krug.backend.shared.domain.model.AllowedFileExtensions;

@Component
public class FilesSettingsAdapter implements FileSettingsPort {

    private final FilesProperties properties;
    private final SystemSettingsPort systemSettings;

    public FilesSettingsAdapter(FilesProperties properties, SystemSettingsPort systemSettings) {
        this.properties = properties;
        this.systemSettings = systemSettings;
    }

    @Override
    public Duration uploadTtl() {
        return properties.getUploadTtl();
    }

    @Override
    public Duration downloadTtl() {
        return properties.getDownloadTtl();
    }

    @Override
    public String artworkBaseUrl() {
        return properties.getArtworkBaseUrl();
    }

    @Override
    public AllowedFileExtensions allowedFileExtensions() {
        return systemSettings.allowedFileExtensions();
    }
}
