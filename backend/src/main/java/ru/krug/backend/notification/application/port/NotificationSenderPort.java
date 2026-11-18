package ru.krug.backend.notification.application.port;

import ru.krug.backend.notification.application.model.EmailNotification;

/**
 * Email delivery seam. E6 ships a log stub; a real provider is v1. Implementations must
 * never throw into the fan-out path (the caller also guards) and must not log content.
 */
public interface NotificationSenderPort {

    void send(EmailNotification notification);
}
