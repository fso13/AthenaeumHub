package ru.krug.backend.auth.application.service;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Service;

import ru.krug.backend.auth.application.event.DeviceKeyChangedEvent;
import ru.krug.backend.auth.application.event.DeviceListChangedEvent;
import ru.krug.backend.auth.application.event.DeviceSessionRevokedEvent;
import ru.krug.backend.auth.application.event.UserSessionsRevokedEvent;
import ru.krug.backend.chat.application.port.ChatKeyScopePort;
import ru.krug.backend.ops.application.model.OutboxEvent;
import ru.krug.backend.ops.application.port.OutboxPort;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.TenantContext;

/**
 * Single place that emits key-lifecycle notifications (E7-B1F P1-03). Every write here is
 * in the caller's transaction: an outbox row (durable metadata) plus a Spring application
 * event that the realtime adapter delivers only after commit. WS events are not
 * replayable and carry no {@code seq}.
 *
 * <p>{@code ops.outbox} is FORCE-RLS by {@code workspace_id} (V8/B-02), so each append
 * re-activates the tenant context for the workspace it writes. A Keycloak principal has no
 * workspace claim, so a device-scoped change may be delivered over WS without a durable
 * row; chat-scoped events always have a workspace.
 */
@Service
public class DeviceKeyEvents {

    private final ApplicationEventPublisher events;
    private final OutboxPort outbox;
    private final ChatKeyScopePort chatScopes;
    private final TenantContext tenantContext;
    private final ClockPort clock;

    public DeviceKeyEvents(ApplicationEventPublisher events, OutboxPort outbox,
                           ChatKeyScopePort chatScopes, TenantContext tenantContext,
                           ClockPort clock) {
        this.events = events;
        this.outbox = outbox;
        this.chatScopes = chatScopes;
        this.tenantContext = tenantContext;
        this.clock = clock;
    }

    /** A new E2EE-capable device: peers must re-read keys, the owner's device list changed. */
    public void deviceRegistered(Principal principal, UUID deviceId, int keyGeneration) {
        fanOutToE2eeChats(principal, DeviceKeyChangedEvent.DEVICE_ADDED, deviceId,
                keyGeneration);
        publishDeviceList(principal, deviceId, "ACTIVE", keyGeneration);
    }

    /** SPK rotation / OPK replenishment: same "re-read keys" signal, no generation change. */
    public void prekeysChanged(Principal principal, UUID deviceId, int keyGeneration) {
        fanOutToE2eeChats(principal, DeviceKeyChangedEvent.KEY_GENERATION_CHANGED, deviceId,
                keyGeneration);
        publishDeviceList(principal, deviceId, "ACTIVE", keyGeneration);
    }

    /** Terminal revoke: every E2EE chat of the owner, the owner's list, and the session. */
    public void deviceRevoked(Principal principal, UUID deviceId, int keyGeneration) {
        fanOutToE2eeChats(principal, DeviceKeyChangedEvent.DEVICE_REVOKED, deviceId,
                keyGeneration);
        publishDeviceList(principal, deviceId, "REVOKED", keyGeneration);
        events.publishEvent(new DeviceSessionRevokedEvent(principal.userId(), deviceId,
                DeviceKeyChangedEvent.DEVICE_REVOKED));
    }

    /** A verification row changed in one chat (only the target device is affected). */
    public void verificationChanged(Principal principal, UUID workspaceId, UUID chatId,
                                    UUID targetDeviceId, int targetKeyGeneration) {
        Instant now = clock.now();
        activate(principal, workspaceId);
        appendChatOutbox(workspaceId, chatId, targetDeviceId,
                DeviceKeyChangedEvent.VERIFICATION_CHANGED, targetKeyGeneration, now);
        events.publishEvent(new DeviceKeyChangedEvent(workspaceId, chatId,
                DeviceKeyChangedEvent.VERIFICATION_CHANGED, targetDeviceId,
                targetKeyGeneration, now));
    }

    public void sessionRevoked(UUID userId, UUID deviceId, String reason) {
        events.publishEvent(new DeviceSessionRevokedEvent(userId, deviceId, reason));
    }

    /**
     * E11-B suspend: close every live WS session of the user after the local status change
     * commits. E2EE device keys are intentionally untouched (the action is reversible).
     */
    public void userSessionsRevoked(UUID userId, String reason) {
        events.publishEvent(new UserSessionsRevokedEvent(userId, reason));
    }

    private void fanOutToE2eeChats(Principal principal, String reason, UUID deviceId,
                                   int keyGeneration) {
        Instant now = clock.now();
        for (ChatKeyScopePort.ChatKeyScope scope : chatScopes.findE2eeChatScopes(
                principal.userId())) {
            activate(principal, scope.workspaceId());
            appendChatOutbox(scope.workspaceId(), scope.chatId(), deviceId, reason,
                    keyGeneration, now);
            events.publishEvent(new DeviceKeyChangedEvent(scope.workspaceId(), scope.chatId(),
                    reason, deviceId, keyGeneration, now));
        }
    }

    private void publishDeviceList(Principal principal, UUID deviceId, String status,
                                   int keyGeneration) {
        Instant now = clock.now();
        if (principal.workspaceId() != null) {
            activate(principal, principal.workspaceId());
            outbox.append(new OutboxEvent(principal.workspaceId(), "device", deviceId,
                    "device.list.changed", 1, principal.userId().toString(),
                    deviceListPayload(deviceId, status, keyGeneration), now));
        }
        events.publishEvent(new DeviceListChangedEvent(principal.workspaceId(),
                principal.userId(), deviceId, status, keyGeneration, now));
    }

    private void activate(Principal principal, UUID workspaceId) {
        if (workspaceId != null) {
            tenantContext.activate(principal.withWorkspace(workspaceId));
        }
    }

    private void appendChatOutbox(UUID workspaceId, UUID chatId, UUID deviceId, String reason,
                                  int keyGeneration, Instant now) {
        if (workspaceId == null) {
            return;
        }
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("chat_id", chatId.toString());
        payload.put("reason", reason);
        payload.put("device_id", deviceId.toString());
        payload.put("key_generation", keyGeneration);
        outbox.append(new OutboxEvent(workspaceId, "device", deviceId, "chat.keys.changed", 1,
                chatId.toString(), payload, now));
    }

    private static Map<String, Object> deviceListPayload(UUID deviceId, String status,
                                                         int keyGeneration) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("device_id", deviceId.toString());
        payload.put("status", status);
        payload.put("key_generation", keyGeneration);
        return payload;
    }
}
