package ru.krug.backend.notification.application.usecase;

import java.time.Instant;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.message.application.event.MessageMentionNotification;
import ru.krug.backend.notification.application.model.EmailNotification;
import ru.krug.backend.notification.application.model.MessageCreatedSignal;
import ru.krug.backend.notification.application.port.ChatDirectoryPort;
import ru.krug.backend.notification.application.port.NotificationSenderPort;
import ru.krug.backend.notification.domain.model.Channel;
import ru.krug.backend.notification.domain.model.Mode;
import ru.krug.backend.notification.domain.model.Notification;
import ru.krug.backend.notification.domain.model.NotificationPreference;
import ru.krug.backend.notification.domain.model.NotificationType;
import ru.krug.backend.notification.domain.repository.NotificationPreferenceRepository;
import ru.krug.backend.notification.domain.repository.NotificationRepository;
import ru.krug.backend.notification.domain.service.NotificationPreferencePolicy;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.TenantContext;

/**
 * Fan-out of {@code message.created} into the per-recipient inbox. Runs after the message
 * transaction commits, in its own transaction:
 *
 * <ul>
 *   <li>only ACTIVE chat members except the sender;</li>
 *   <li>dedupe by {@code (user, chat, message, type)} through the unique index;</li>
 *   <li>IN_APP preference ALL/MENTIONS/MUTE decides whether a row is created at all;</li>
 *   <li>EMAIL preference (default MUTE) is evaluated only for a newly inserted row;</li>
 *   <li>body is always null — no message content enters this module.</li>
 * </ul>
 *
 * <p>Each recipient is written under their own RLS GUC. That keeps the notification table
 * protected by {@code user_id = current_user} even for the fan-out writer, without a broad
 * worker bypass for inserts.</p>
 */
@Service
public class NotifyUseCase {

    private static final Logger log = LoggerFactory.getLogger(NotifyUseCase.class);

    private final TenantContext tenantContext;
    private final NotificationRepository notifications;
    private final NotificationPreferenceRepository preferences;
    private final ChatDirectoryPort chatDirectory;
    private final NotificationSenderPort sender;
    private final ClockPort clock;

    public NotifyUseCase(TenantContext tenantContext, NotificationRepository notifications,
                         NotificationPreferenceRepository preferences,
                         ChatDirectoryPort chatDirectory, NotificationSenderPort sender,
                         ClockPort clock) {
        this.tenantContext = tenantContext;
        this.notifications = notifications;
        this.preferences = preferences;
        this.chatDirectory = chatDirectory;
        this.sender = sender;
        this.clock = clock;
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public int notifyMessageCreated(MessageCreatedSignal signal) {
        ChatDirectoryPort.ChatDirectory chat = chatDirectory
                .findChat(signal.workspaceId(), signal.chatId())
                .orElse(null);
        if (chat == null) {
            log.info("notification.fanout.chat_missing chat_id={} message_id={}",
                    signal.chatId(), signal.messageId());
            return 0;
        }

        Instant now = clock.now();
        Set<UUID> seen = new HashSet<>();
        int created = 0;
        for (UUID recipient : chat.activeMemberIds()) {
            if (recipient == null || recipient.equals(signal.senderId()) || !seen.add(recipient)) {
                continue;
            }
            if (notifyRecipient(signal, recipient, now)) {
                created++;
            }
        }
        log.info("notification.fanout message_id={} chat_id={} recipients={} created={}",
                signal.messageId(), signal.chatId(), chat.activeMemberIds().size(), created);
        return created;
    }

    /**
     * #83 MENTION fan-out: one row per mentioned recipient (explicit ids plus the materialised
     * @all audience, sender already removed by the message layer). The notification body is
     * always null — mention notifications carry no message content. Preferences are applied
     * per recipient exactly like MESSAGE; MUTE suppresses the row, MENTIONS/ALL allow it.
     */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public int notifyMentioned(MessageMentionNotification event) {
        if (event.recipientIds().isEmpty()) {
            return 0;
        }
        Instant now = clock.now();
        Set<UUID> seen = new HashSet<>();
        int created = 0;
        for (UUID recipient : event.recipientIds()) {
            if (recipient == null || recipient.equals(event.senderId()) || !seen.add(recipient)) {
                continue;
            }
            if (notifyMentionRecipient(event, recipient, now)) {
                created++;
            }
        }
        log.info("notification.mention message_id={} chat_id={} recipients={} created={}",
                event.messageId(), event.chatId(), event.recipientIds().size(), created);
        return created;
    }

    private boolean notifyMentionRecipient(MessageMentionNotification event, UUID recipient,
                                           Instant now) {
        tenantContext.activate(new Principal(recipient, null, event.workspaceId(),
                "mention-fanout:" + event.messageId()));
        List<NotificationPreference> recipientPreferences = preferences.findByUser(recipient);
        Mode inApp = NotificationPreferencePolicy.resolve(recipientPreferences,
                event.workspaceId(), event.chatId(), NotificationType.MENTION,
                Channel.IN_APP);
        if (!inApp.allows(NotificationType.MENTION)) {
            return false;
        }
        Notification notification = Notification.create(UUID.randomUUID(), recipient,
                event.workspaceId(), event.chatId(), NotificationType.MENTION,
                Notification.MENTION_TITLE,
                Notification.dedupeKey(recipient, event.chatId(), event.messageId(),
                        NotificationType.MENTION),
                now);
        if (!notifications.saveIfAbsent(notification)) {
            return false;
        }
        Mode email = NotificationPreferencePolicy.resolve(recipientPreferences,
                event.workspaceId(), event.chatId(), NotificationType.MENTION,
                Channel.EMAIL);
        if (email.allows(NotificationType.MENTION)) {
            try {
                sender.send(new EmailNotification(notification.id(), recipient,
                        event.chatId(), NotificationType.MENTION));
            } catch (RuntimeException ex) {
                log.warn("notification.email_failed notification_id={} user_id={}",
                        notification.id(), recipient);
            }
        }
        return true;
    }

    private boolean notifyRecipient(MessageCreatedSignal signal, UUID recipient, Instant now) {
        tenantContext.activate(new Principal(recipient, null, signal.workspaceId(),
                "notification-fanout:" + signal.messageId()));
        List<NotificationPreference> recipientPreferences = preferences.findByUser(recipient);
        Mode inApp = NotificationPreferencePolicy.resolve(recipientPreferences, signal.workspaceId(),
                signal.chatId(), NotificationType.MESSAGE, Channel.IN_APP);
        if (!inApp.allows(NotificationType.MESSAGE)) {
            return false;
        }

        Notification notification = Notification.create(UUID.randomUUID(), recipient,
                signal.workspaceId(), signal.chatId(), NotificationType.MESSAGE,
                Notification.NEW_MESSAGE_TITLE,
                Notification.dedupeKey(recipient, signal.chatId(), signal.messageId(),
                        NotificationType.MESSAGE),
                now);
        if (!notifications.saveIfAbsent(notification)) {
            return false;
        }

        Mode email = NotificationPreferencePolicy.resolve(recipientPreferences, signal.workspaceId(),
                signal.chatId(), NotificationType.MESSAGE, Channel.EMAIL);
        if (email.allows(NotificationType.MESSAGE)) {
            try {
                sender.send(new EmailNotification(notification.id(), recipient,
                        signal.chatId(), NotificationType.MESSAGE));
            } catch (RuntimeException ex) {
                // A stub/provider failure must never affect the message send or other recipients.
                log.warn("notification.email_failed notification_id={} user_id={}",
                        notification.id(), recipient);
            }
        }
        return true;
    }
}
