package ru.krug.backend.realtime.infrastructure.event;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.transaction.event.TransactionPhase;
import org.springframework.transaction.event.TransactionalEventListener;

import ru.krug.backend.message.application.event.MessageCreatedNotification;
import ru.krug.backend.message.application.model.MessageView;
import ru.krug.backend.realtime.application.model.AttachmentSnapshot;
import ru.krug.backend.realtime.application.model.MessageSnapshot;
import ru.krug.backend.realtime.application.model.StickerSnapshot;
import ru.krug.backend.realtime.application.port.RealtimePublisherPort;
import ru.krug.backend.realtime.application.service.RealtimeEventFactory;
import ru.krug.backend.shared.application.port.E2eeSettingsPort;

/**
 * After the message transaction commits, fan out {@code message.created} to the in-process
 * hub. Any failure here is logged and swallowed: the REST send already succeeded and the
 * client can recover through replay.
 */
@Component
public class RealtimeMessageCreatedListener {

    private static final Logger log = LoggerFactory.getLogger(RealtimeMessageCreatedListener.class);

    private final RealtimePublisherPort publisher;
    private final E2eeSettingsPort e2eeSettings;

    public RealtimeMessageCreatedListener(RealtimePublisherPort publisher,
                                          E2eeSettingsPort e2eeSettings) {
        this.publisher = publisher;
        this.e2eeSettings = e2eeSettings;
    }

    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void onMessageCreated(MessageCreatedNotification notification) {
        try {
            MessageView view = notification.message();
            // P2-03 kill-switch: never fan out an E2EE frame while the flag is off, even
            // if the send committed just before the operator flipped it.
            if (view.isE2ee() && !e2eeSettings.enabled()) {
                return;
            }
            MessageSnapshot snapshot = new MessageSnapshot(notification.workspaceId(), view.id(),
                    view.chatId(), view.seq(), view.type(), view.senderId(),
                    view.senderDisplayName(), view.text(), view.replyToId(),
                    view.threadRootId(), view.createdAt(), view.editedAt(), view.deletedAt(),
                    view.version(), view.clientMessageId(), view.crypto(), view.stickerId(),
                    view.sticker() == null ? null : new StickerSnapshot(view.sticker().id(),
                            view.sticker().packId(), view.sticker().alt(),
                            view.sticker().url(), view.sticker().favorite()),
                    view.attachments().stream()
                            .map(attachment -> new AttachmentSnapshot(attachment.id(),
                                    attachment.filename(), attachment.sizeBytes(),
                                    attachment.mimeType(), attachment.scanStatus()))
                            .toList());
            publisher.publish(RealtimeEventFactory.messageCreated(snapshot,
                    notification.cryptoByDevice()));
        } catch (RuntimeException ex) {
            log.warn("realtime.message_fanout_failed message_id={}",
                    notification.message().id());
        }
    }
}
