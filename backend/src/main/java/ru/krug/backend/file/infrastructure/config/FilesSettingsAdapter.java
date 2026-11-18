package ru.krug.backend.file.infrastructure.config;

import java.time.Duration;

import org.springframework.stereotype.Component;

import ru.krug.backend.file.application.port.FileSettingsPort;

@Component
public class FilesSettingsAdapter implements FileSettingsPort {

    private final FilesProperties properties;

    public FilesSettingsAdapter(FilesProperties properties) {
        this.properties = properties;
    }

    @Override
    public Duration uploadTtl() {
        return properties.getUploadTtl();
    }

    @Override
    public Duration downloadTtl() {
        return properties.getDownloadTtl();
    }
}
