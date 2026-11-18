package ru.krug.backend.notification.infrastructure.event;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.transaction.event.TransactionPhase;
import org.springframework.transaction.event.TransactionalEventListener;

import ru.krug.backend.message.application.event.MessageCreatedNotification;
import ru.krug.backend.message.application.model.MessageView;
import ru.krug.backend.notification.application.model.MessageCreatedSignal;
import ru.krug.backend.notification.application.usecase.NotifyUseCase;

/**
 * Consumes the same in-process {@code message.created} event as realtime, but only after
 * the message transaction commits. Failure is swallowed: the REST send already succeeded,
 * and the notification can be recreated by a later event/replay without breaking messaging.
 */
@Component
public class NotificationMessageCreatedListener {

    private static final Logger log = LoggerFactory.getLogger(NotificationMessageCreatedListener.class);

    private final NotifyUseCase notifyUseCase;

    public NotificationMessageCreatedListener(NotifyUseCase notifyUseCase) {
        this.notifyUseCase = notifyUseCase;
    }

    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void onMessageCreated(MessageCreatedNotification event) {
        MessageView message = event.message();
        try {
            notifyUseCase.notifyMessageCreated(new MessageCreatedSignal(event.workspaceId(),
                    message.chatId(), message.id(), message.senderId(), message.createdAt()));
        } catch (RuntimeException ex) {
            log.warn("notification.fanout_failed message_id={} chat_id={}",
                    message.id(), message.chatId());
        }
    }
}
