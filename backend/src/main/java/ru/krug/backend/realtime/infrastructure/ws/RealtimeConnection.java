package ru.krug.backend.realtime.infrastructure.ws;

import java.io.IOException;
import java.time.Instant;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executor;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.PingMessage;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

import ru.krug.backend.realtime.application.model.RealtimeSession;

/**
 * One WS connection with a single-writer outbound queue. Sending never blocks the hub or
 * other connections: drain tasks run on a virtual-thread executor, and a slow consumer is
 * disconnected with 1013 instead of stalling fan-out.
 */
public final class RealtimeConnection {

    private static final Logger log = LoggerFactory.getLogger(RealtimeConnection.class);

    private final RealtimeSession session;
    private final WebSocketSession webSocket;
    private final OutboundQueue queue;
    private final Executor executor;
    private final Set<UUID> chats = ConcurrentHashMap.newKeySet();
    private final Map<UUID, Long> replayBoundary = new ConcurrentHashMap<>();
    private final Map<UUID, Long> lastDelivered = new ConcurrentHashMap<>();
    private final AtomicBoolean draining = new AtomicBoolean();
    private final AtomicBoolean closed = new AtomicBoolean();
    private final AtomicReference<CloseStatus> closeAfterFlush = new AtomicReference<>();

    private volatile boolean presenceEnabled;
    private volatile Instant lastActivity;
    private volatile long ackedSeq;

    public RealtimeConnection(RealtimeSession session, WebSocketSession webSocket, int capacity,
                              Executor executor) {
        this.session = session;
        this.webSocket = webSocket;
        this.queue = new OutboundQueue(capacity);
        this.executor = executor;
        this.lastActivity = Instant.now();
    }

    public String sessionId() {
        return session.sessionId();
    }

    public RealtimeSession session() {
        return session;
    }

    public Instant lastActivity() {
        return lastActivity;
    }

    public void touch() {
        lastActivity = Instant.now();
    }

    public long ackedSeq() {
        return ackedSeq;
    }

    public void ack(long seq) {
        ackedSeq = Math.max(ackedSeq, seq);
        touch();
    }

    public boolean presenceEnabled() {
        return presenceEnabled;
    }

    public void setPresenceEnabled(boolean enabled) {
        this.presenceEnabled = enabled;
    }

    public boolean addChat(UUID chatId) {
        return chats.add(chatId);
    }

    public Set<UUID> chats() {
        return Set.copyOf(chats);
    }

    public boolean isClosed() {
        return closed.get();
    }

    /**
     * Remembers the highest replayed seq per chat. Live events at or below it are duplicates
     * of the replay and are not enqueued again.
     */
    public void markReplayed(UUID chatId, long seq) {
        replayBoundary.merge(chatId, seq, Math::max);
    }

    public void enqueue(OutboundFrame frame) {
        if (closed.get()) {
            return;
        }
        if (frame.chatId() != null && frame.seq() != null) {
            Long boundary = replayBoundary.get(frame.chatId());
            if (boundary != null && frame.seq() <= boundary) {
                return;
            }
        }
        OutboundQueue.OfferResult result = queue.offer(frame);
        if (result == OutboundQueue.OfferResult.OVERFLOW) {
            closeSlowConsumer();
            return;
        }
        if (result == OutboundQueue.OfferResult.ACCEPTED) {
            scheduleDrain();
        }
    }

    public void sendPing() {
        enqueue(OutboundFrame.heartbeat());
    }

    public void close(CloseStatus status) {
        if (!closed.compareAndSet(false, true)) {
            return;
        }
        queue.clear();
        try {
            executor.execute(() -> closeQuietly(status));
        } catch (RuntimeException ex) {
            closeQuietly(status);
        }
    }

    /** Sends already queued frames (for example an error) and then closes the connection. */
    public void closeAfterFlush(CloseStatus status) {
        if (closed.get() || !closeAfterFlush.compareAndSet(null, status)) {
            return;
        }
        scheduleDrain();
    }

    public void closeSlowConsumer() {
        long lastSeq = lastDelivered.values().stream().mapToLong(Long::longValue).max().orElse(0L);
        log.warn("ws.slow_consumer session_id={} last_delivered_seq={}",
                session.sessionId(), lastSeq);
        close(new CloseStatus(WsCloseCodes.SLOW_CONSUMER,
                "SLOW_CONSUMER last_delivered_seq=" + lastSeq));
    }

    /** Marks the connection closed without sending a close frame (already closed peer). */
    public void markClosed() {
        closed.set(true);
        queue.clear();
    }

    private void scheduleDrain() {
        if (!draining.compareAndSet(false, true)) {
            return;
        }
        try {
            executor.execute(this::drain);
        } catch (RuntimeException ex) {
            draining.set(false);
        }
    }

    private void drain() {
        while (!closed.get()) {
            OutboundFrame frame = queue.poll();
            if (frame == null) {
                CloseStatus pending = closeAfterFlush.get();
                if (pending != null && queue.size() == 0) {
                    closed.set(true);
                    closeQuietly(pending);
                    return;
                }
                draining.set(false);
                if (queue.size() == 0 || !draining.compareAndSet(false, true)) {
                    return;
                }
                continue;
            }
            try {
                if (frame.ping()) {
                    webSocket.sendMessage(new PingMessage());
                } else {
                    webSocket.sendMessage(new TextMessage(frame.json()));
                }
                if (frame.chatId() != null && frame.seq() != null) {
                    lastDelivered.merge(frame.chatId(), frame.seq(), Math::max);
                }
            } catch (IOException | RuntimeException ex) {
                closeSlowConsumer();
                return;
            }
        }
    }

    private void closeQuietly(CloseStatus status) {
        try {
            if (webSocket.isOpen()) {
                webSocket.close(status);
            }
        } catch (IOException | RuntimeException ex) {
            log.debug("ws.close_failed session_id={}", session.sessionId());
        }
    }
}
