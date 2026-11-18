package ru.krug.backend.realtime.infrastructure.event;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.transaction.event.TransactionPhase;
import org.springframework.transaction.event.TransactionalEventListener;

import ru.krug.backend.auth.application.event.DeviceKeyChangedEvent;
import ru.krug.backend.auth.application.event.DeviceListChangedEvent;
import ru.krug.backend.auth.application.event.DeviceSessionRevokedEvent;
import ru.krug.backend.auth.application.event.UserSessionsRevokedEvent;
import ru.krug.backend.realtime.application.port.RealtimePublisherPort;

/**
 * Key-lifecycle fan-out (E7-B1F P1-03). Runs only after the write transaction commits, so
 * a rollback never leaks a key event. Failures are logged and swallowed: the REST call
 * already succeeded and clients re-read keys on reconnect anyway.
 */
@Component
public class RealtimeDeviceKeyListener {

    private static final Logger log = LoggerFactory.getLogger(RealtimeDeviceKeyListener.class);

    private final RealtimePublisherPort publisher;

    public RealtimeDeviceKeyListener(RealtimePublisherPort publisher) {
        this.publisher = publisher;
    }

    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void onKeyChanged(DeviceKeyChangedEvent event) {
        try {
            publisher.publishKeyChanged(event.workspaceId(), event.chatId(), event.reason(),
                    event.deviceId(), event.keyGeneration(), event.occurredAt());
        } catch (RuntimeException ex) {
            log.warn("realtime.key_changed_failed chat_id={} reason={}", event.chatId(),
                    event.reason());
        }
    }

    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void onDeviceListChanged(DeviceListChangedEvent event) {
        try {
            publisher.publishDeviceListChanged(event.userId(), event.deviceId(),
                    event.status(), event.keyGeneration(), event.occurredAt());
        } catch (RuntimeException ex) {
            log.warn("realtime.device_list_changed_failed device_id={}", event.deviceId());
        }
    }

    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void onSessionRevoked(DeviceSessionRevokedEvent event) {
        try {
            publisher.publishSessionRevoked(event.userId(), event.deviceId(), event.reason());
        } catch (RuntimeException ex) {
            log.warn("realtime.session_revoked_failed device_id={}", event.deviceId());
        }
    }

    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void onUserSessionsRevoked(UserSessionsRevokedEvent event) {
        try {
            publisher.publishUserSessionsRevoked(event.userId(), event.reason());
        } catch (RuntimeException ex) {
            log.warn("realtime.user_sessions_revoked_failed user_id={}", event.userId());
        }
    }
}
