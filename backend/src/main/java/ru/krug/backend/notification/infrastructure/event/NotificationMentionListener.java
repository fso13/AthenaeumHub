package ru.krug.backend.notification.infrastructure.event;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.transaction.event.TransactionPhase;
import org.springframework.transaction.event.TransactionalEventListener;

import ru.krug.backend.message.application.event.MessageMentionNotification;
import ru.krug.backend.notification.application.usecase.NotifyUseCase;

/**
 * #83: turns a committed mention into per-recipient MENTION notifications. Runs after the
 * message transaction commits; a failure is swallowed because the message (and the durable
 * {@code message.mentions} rows) already succeeded.
 */
@Component
public class NotificationMentionListener {

    private static final Logger log =
            LoggerFactory.getLogger(NotificationMentionListener.class);

    private final NotifyUseCase notifyUseCase;

    public NotificationMentionListener(NotifyUseCase notifyUseCase) {
        this.notifyUseCase = notifyUseCase;
    }

    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void onMessageMentioned(MessageMentionNotification event) {
        try {
            notifyUseCase.notifyMentioned(event);
        } catch (RuntimeException ex) {
            log.warn("notification.mention_fanout_failed message_id={} chat_id={}",
                    event.messageId(), event.chatId());
        }
    }
}
