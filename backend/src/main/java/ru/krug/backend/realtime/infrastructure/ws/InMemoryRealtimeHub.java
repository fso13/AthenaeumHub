package ru.krug.backend.realtime.infrastructure.ws;

import java.time.Instant;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.locks.ReentrantLock;

import jakarta.annotation.PreDestroy;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.WebSocketSession;

import ru.krug.backend.realtime.application.model.EphemeralEvent;
import ru.krug.backend.realtime.application.model.RealtimeEvent;
import ru.krug.backend.realtime.application.model.RealtimeSession;
import ru.krug.backend.realtime.application.model.ReplayBatch;
import ru.krug.backend.realtime.application.model.SubscriptionPlan;
import ru.krug.backend.realtime.application.port.RealtimePublisherPort;
import ru.krug.backend.realtime.application.port.RealtimeSettingsPort;
import ru.krug.backend.realtime.application.port.RealtimeSubscriptionPort;

/**
 * Single-node in-process fan-out hub (E3-D-01). A per-chat lock makes replay+register and
 * publish mutually exclusive, so a live event can never fall between the replay query and
 * the live subscription. Delivery is at-least-once; duplicates are filtered at the replay
 * boundary and by event_id on the client.
 */
@Component
public class InMemoryRealtimeHub implements RealtimePublisherPort, RealtimeSubscriptionPort {

    private static final Logger log = LoggerFactory.getLogger(InMemoryRealtimeHub.class);

    private final WsFrameCodec codec;
    private final RealtimeSettingsPort settings;
    private final ExecutorService writerExecutor;

    private final Map<String, RealtimeConnection> connections = new ConcurrentHashMap<>();
    private final Map<UUID, Set<String>> subscribers = new ConcurrentHashMap<>();
    private final Map<UUID, ReentrantLock> chatLocks = new ConcurrentHashMap<>();

    public InMemoryRealtimeHub(WsFrameCodec codec, RealtimeSettingsPort settings,
                               @Qualifier("realtimeWriterExecutor")
                               ExecutorService writerExecutor) {
        this.codec = codec;
        this.settings = settings;
        this.writerExecutor = writerExecutor;
    }

    public RealtimeConnection register(RealtimeSession session, WebSocketSession webSocket) {
        RealtimeConnection connection = new RealtimeConnection(session, webSocket,
                settings.outboundQueueCapacity(), writerExecutor);
        connections.put(session.sessionId(), connection);
        log.info("ws.connected session_id={} user_id={} device_id={}",
                session.sessionId(), session.userId(), session.deviceId());
        return connection;
    }

    public RealtimeConnection connection(String sessionId) {
        return connections.get(sessionId);
    }

    @Override
    public void activate(SubscriptionPlan plan) {
        RealtimeConnection connection = connections.get(plan.sessionId());
        if (connection == null) {
            return;
        }
        connection.setPresenceEnabled(plan.presence());
        for (ReplayBatch batch : plan.replays()) {
            UUID chatId = batch.chatId();
            ReentrantLock lock = lockFor(chatId);
            lock.lock();
            try {
                if (!connection.addChat(chatId)) {
                    continue;
                }
                subscribers.computeIfAbsent(chatId, key -> ConcurrentHashMap.newKeySet())
                        .add(plan.sessionId());
                long boundary = 0L;
                if (batch.gap() != null) {
                    connection.enqueue(OutboundFrame.text(codec.gap(batch.gap()), false,
                            chatId, null));
                    boundary = batch.gap().toSeq();
                }
                for (RealtimeEvent event : batch.events()) {
                    connection.enqueue(OutboundFrame.text(
                            codec.event(event, connection.session().deviceId()), false, chatId,
                            event.seq()));
                    boundary = Math.max(boundary, event.seq());
                }
                connection.markReplayed(chatId, boundary);
            } finally {
                lock.unlock();
            }
        }
    }

    @Override
    public void deactivate(String sessionId) {
        unregister(sessionId);
    }

    @Override
    public void publish(RealtimeEvent event) {
        ReentrantLock lock = lockFor(event.chatId());
        lock.lock();
        try {
            Set<String> sessionIds = subscribers.get(event.chatId());
            if (sessionIds == null || sessionIds.isEmpty()) {
                return;
            }
            for (String sessionId : sessionIds) {
                RealtimeConnection connection = connections.get(sessionId);
                if (connection != null) {
                    // E2EE: the frame carries only this connection's envelope (or null).
                    String json = codec.event(event, connection.session().deviceId());
                    connection.enqueue(OutboundFrame.text(json, false, event.chatId(),
                            event.seq()));
                }
            }
        } finally {
            lock.unlock();
        }
    }

    @Override
    public void publishEphemeral(EphemeralEvent event, String excludeSessionId) {
        Set<String> sessionIds = subscribers.get(event.chatId());
        if (sessionIds == null || sessionIds.isEmpty()) {
            return;
        }
        String json = codec.ephemeral(event);
        for (String sessionId : sessionIds) {
            if (sessionId.equals(excludeSessionId)) {
                continue;
            }
            RealtimeConnection connection = connections.get(sessionId);
            if (connection == null) {
                continue;
            }
            if ("presence".equals(event.event()) && !connection.presenceEnabled()) {
                continue;
            }
            connection.enqueue(OutboundFrame.text(json, true, event.chatId(), null));
        }
    }

    @Override
    public void publishKeyChanged(UUID workspaceId, UUID chatId, String reason, UUID deviceId,
                                  Integer keyGeneration, Instant occurredAt) {
        ReentrantLock lock = lockFor(chatId);
        lock.lock();
        try {
            Set<String> sessionIds = subscribers.get(chatId);
            if (sessionIds == null || sessionIds.isEmpty()) {
                return;
            }
            String json = codec.keyChanged(workspaceId, chatId, reason, deviceId,
                    keyGeneration, occurredAt);
            for (String sessionId : sessionIds) {
                RealtimeConnection connection = connections.get(sessionId);
                if (connection != null) {
                    connection.enqueue(OutboundFrame.control(json));
                }
            }
        } finally {
            lock.unlock();
        }
    }

    @Override
    public void publishDeviceListChanged(UUID userId, UUID deviceId, String status,
                                         int keyGeneration, Instant occurredAt) {
        String json = codec.deviceListChanged(null, deviceId, status, keyGeneration,
                occurredAt);
        for (RealtimeConnection connection : connections.values()) {
            if (connection.session().userId().equals(userId)) {
                connection.enqueue(OutboundFrame.control(json));
            }
        }
    }

    @Override
    public void publishSessionRevoked(UUID userId, UUID deviceId, String reason) {
        String json = codec.sessionRevoked(reason);
        for (RealtimeConnection connection : connections.values()) {
            if (connection.session().userId().equals(userId)
                    && connection.session().deviceId().equals(deviceId)) {
                connection.enqueue(OutboundFrame.control(json));
                connection.closeAfterFlush(new CloseStatus(WsCloseCodes.FORBIDDEN, reason));
            }
        }
    }

    @Override
    public void publishUserSessionsRevoked(UUID userId, String reason) {
        String json = codec.sessionRevoked(reason);
        for (RealtimeConnection connection : connections.values()) {
            if (connection.session().userId().equals(userId)) {
                connection.enqueue(OutboundFrame.control(json));
                connection.closeAfterFlush(new CloseStatus(WsCloseCodes.FORBIDDEN, reason));
            }
        }
    }

    /** Server heartbeat: ping live sessions, close sessions above the 60 s timeout. */
    public void heartbeat(Instant now) {
        for (Map.Entry<String, RealtimeConnection> entry : connections.entrySet()) {
            RealtimeConnection connection = entry.getValue();
            if (connection.isClosed()) {
                unregister(entry.getKey());
                continue;
            }
            if (now.isAfter(connection.lastActivity().plus(settings.heartbeatTimeout()))) {
                log.info("ws.heartbeat_timeout session_id={}", entry.getKey());
                connection.close(new CloseStatus(WsCloseCodes.POLICY_VIOLATION,
                        "HEARTBEAT_TIMEOUT"));
                unregister(entry.getKey());
            } else {
                connection.sendPing();
            }
        }
    }

    public void unregister(String sessionId) {
        RealtimeConnection connection = connections.remove(sessionId);
        if (connection == null) {
            return;
        }
        for (UUID chatId : connection.chats()) {
            Set<String> sessionIds = subscribers.get(chatId);
            if (sessionIds != null) {
                sessionIds.remove(sessionId);
                if (sessionIds.isEmpty()) {
                    subscribers.remove(chatId, sessionIds);
                }
            }
        }
        connection.markClosed();
        log.info("ws.disconnected session_id={}", sessionId);
    }

    public int connectionCount() {
        return connections.size();
    }

    public int subscriptionCount() {
        return subscribers.values().stream().mapToInt(Set::size).sum();
    }

    public int subscriptionCount(String sessionId) {
        RealtimeConnection connection = connections.get(sessionId);
        return connection == null ? 0 : connection.chats().size();
    }

    @PreDestroy
    void shutdown() {
        for (RealtimeConnection connection : connections.values()) {
            connection.close(new CloseStatus(WsCloseCodes.NORMAL, "SERVER_SHUTDOWN"));
        }
        connections.clear();
        subscribers.clear();
    }

    private ReentrantLock lockFor(UUID chatId) {
        return chatLocks.computeIfAbsent(chatId, key -> new ReentrantLock());
    }
}
