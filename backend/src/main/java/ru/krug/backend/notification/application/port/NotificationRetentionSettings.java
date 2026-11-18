package ru.krug.backend.notification.application.port;

/** Application-owned view of the notification retention policy (90 days by default). */
public interface NotificationRetentionSettings {

    int retentionDays();

    int batchSize();
}
