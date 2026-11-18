package ru.krug.backend.realtime.infrastructure.event;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.transaction.event.TransactionPhase;
import org.springframework.transaction.event.TransactionalEventListener;

import ru.krug.backend.chat.application.event.ReadReceiptNotification;
import ru.krug.backend.realtime.application.port.RealtimePublisherPort;
import ru.krug.backend.realtime.application.service.RealtimeEventFactory;

/** Fans out {@code message.receipt} after the read receipt commits. Not replayed. */
@Component
public class RealtimeReadReceiptListener {

    private static final Logger log = LoggerFactory.getLogger(RealtimeReadReceiptListener.class);

    private final RealtimePublisherPort publisher;

    public RealtimeReadReceiptListener(RealtimePublisherPort publisher) {
        this.publisher = publisher;
    }

    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void onReadReceipt(ReadReceiptNotification notification) {
        try {
            publisher.publish(RealtimeEventFactory.messageReceipt(notification.workspaceId(),
                    notification.chatId(), notification.userId(),
                    notification.lastReadSeq(), notification.readAt()));
        } catch (RuntimeException ex) {
            log.warn("realtime.receipt_fanout_failed chat_id={}", notification.chatId());
        }
    }
}
