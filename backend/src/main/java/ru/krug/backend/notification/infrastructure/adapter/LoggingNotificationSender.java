package ru.krug.backend.notification.infrastructure.adapter;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.core.task.TaskExecutor;
import org.springframework.stereotype.Component;

import ru.krug.backend.notification.application.model.EmailNotification;
import ru.krug.backend.notification.application.port.NotificationSenderPort;

/**
 * E6 dev email stub: logs delivery metadata without content and dispatches on a small
 * dedicated executor, so a slow/failed provider can never block the HTTP request or the
 * in-app fan-out.
 */
@Component
public class LoggingNotificationSender implements NotificationSenderPort {

    private static final Logger log = LoggerFactory.getLogger(LoggingNotificationSender.class);

    private final TaskExecutor executor;

    public LoggingNotificationSender(
            @Qualifier("notificationEmailExecutor") TaskExecutor executor) {
        this.executor = executor;
    }

    @Override
    public void send(EmailNotification notification) {
        try {
            executor.execute(() -> log.info(
                    "notification.email.stub notification_id={} user_id={} type={} chat_id={}",
                    notification.notificationId(), notification.userId(),
                    notification.type(), notification.chatId()));
        } catch (RuntimeException ex) {
            // Executor rejection is not an application error: the in-app row already exists.
            log.warn("notification.email.enqueue_failed notification_id={}",
                    notification.notificationId());
        }
    }
}
