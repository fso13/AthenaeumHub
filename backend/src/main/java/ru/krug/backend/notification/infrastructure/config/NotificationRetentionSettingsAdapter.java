package ru.krug.backend.notification.infrastructure.config;

import org.springframework.stereotype.Component;

import ru.krug.backend.notification.application.port.NotificationRetentionSettings;

@Component
public class NotificationRetentionSettingsAdapter implements NotificationRetentionSettings {

    private final NotificationProperties properties;

    public NotificationRetentionSettingsAdapter(NotificationProperties properties) {
        this.properties = properties;
    }

    @Override
    public int retentionDays() {
        return properties.retentionDays();
    }

    @Override
    public int batchSize() {
        return properties.retentionBatchSize();
    }
}
