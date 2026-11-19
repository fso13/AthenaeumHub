package ru.krug.backend.realtime.infrastructure.event;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.transaction.event.TransactionPhase;
import org.springframework.transaction.event.TransactionalEventListener;

import ru.krug.backend.message.application.event.MessageDeletedNotification;
import ru.krug.backend.message.application.event.MessageReactionNotification;
import ru.krug.backend.message.application.event.MessageUpdatedNotification;
import ru.krug.backend.realtime.application.port.RealtimePublisherPort;
import ru.krug.backend.realtime.application.service.MessageSnapshotMapper;
import ru.krug.backend.realtime.application.service.RealtimeEventFactory;
import ru.krug.backend.shared.application.port.E2eeSettingsPort;

/**
 * After-commit fan-out for message actions (#61-#63). Any failure is logged and swallowed:
 * the REST operation already committed and the client reconciles through REST/replay.
 *
 * <p>Delete-for-me is not handled here on purpose: it changes only the caller's timeline
 * and must never reach other subscribers. Delete-for-all, edits and reactions are managed
 * features; the E2EE kill-switch still suppresses a content-free E2EE tombstone frame.
 */
@Component
public class RealtimeMessageActionsListener {

    private static final Logger log =
            LoggerFactory.getLogger(RealtimeMessageActionsListener.class);

    private final RealtimePublisherPort publisher;
    private final E2eeSettingsPort e2eeSettings;

    public RealtimeMessageActionsListener(RealtimePublisherPort publisher,
                                          E2eeSettingsPort e2eeSettings) {
        this.publisher = publisher;
        this.e2eeSettings = e2eeSettings;
    }

    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void onUpdated(MessageUpdatedNotification notification) {
        try {
            publisher.publish(RealtimeEventFactory.messageUpdated(
                    MessageSnapshotMapper.from(notification.workspaceId(),
                            notification.message())));
        } catch (RuntimeException ex) {
            log.warn("realtime.message_updated_fanout_failed message_id={}",
                    notification.message().id());
        }
    }

    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void onDeleted(MessageDeletedNotification notification) {
        try {
            if (notification.e2ee() && !e2eeSettings.enabled()) {
                return;
            }
            publisher.publish(RealtimeEventFactory.messageDeleted(notification.workspaceId(),
                    notification.chatId(), notification.messageId(), notification.seq(),
                    notification.deletedAt(), notification.deletedBy(), notification.scope()));
        } catch (RuntimeException ex) {
            log.warn("realtime.message_deleted_fanout_failed message_id={}",
                    notification.messageId());
        }
    }

    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void onReaction(MessageReactionNotification notification) {
        try {
            if (notification.e2ee() && !e2eeSettings.enabled()) {
                return;
            }
            publisher.publish(RealtimeEventFactory.messageReactionChanged(
                    notification.workspaceId(), notification.chatId(),
                    notification.messageId(), notification.seq(), notification.userId(),
                    notification.emoji(), notification.action(), notification.count(),
                    java.time.Instant.now()));
        } catch (RuntimeException ex) {
            log.warn("realtime.message_reaction_fanout_failed message_id={}",
                    notification.messageId());
        }
    }
}
