package ru.krug.backend.realtime.infrastructure.ws;

import java.util.List;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.PongMessage;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import ru.krug.backend.realtime.application.model.ChatSubscription;
import ru.krug.backend.realtime.application.model.PresenceStatus;
import ru.krug.backend.realtime.application.model.RealtimeSession;
import ru.krug.backend.realtime.application.model.SubscribedChat;
import ru.krug.backend.realtime.application.model.SubscriptionPlan;
import ru.krug.backend.realtime.application.port.RealtimeDevicePort;
import ru.krug.backend.realtime.application.port.RealtimeSettingsPort;
import ru.krug.backend.realtime.application.usecase.SubscriptionService;
import ru.krug.backend.realtime.domain.exception.RealtimeSessionRevokedException;
import ru.krug.backend.realtime.domain.exception.RealtimeTicketInvalidException;
import ru.krug.backend.realtime.domain.exception.SubscriptionLimitExceededException;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * WS protocol v1 transport. Frames are authenticated by the handshake ticket; every chat is
 * membership-checked on subscribe/typing/presence. Unknown or malformed frames close 1008.
 */
@Component
public class RealtimeWebSocketHandler extends TextWebSocketHandler {

    private static final Logger log = LoggerFactory.getLogger(RealtimeWebSocketHandler.class);
    private static final int MAX_FRAME_BYTES = 64 * 1024;

    private final InMemoryRealtimeHub hub;
    private final SubscriptionService subscriptionService;
    private final RealtimeDevicePort devicePort;
    private final RealtimeSettingsPort settings;
    private final WsFrameCodec codec;
    private final ObjectMapper mapper;

    public RealtimeWebSocketHandler(InMemoryRealtimeHub hub,
                                    SubscriptionService subscriptionService,
                                    RealtimeDevicePort devicePort,
                                    RealtimeSettingsPort settings,
                                    WsFrameCodec codec,
                                    ObjectMapper mapper) {
        this.hub = hub;
        this.subscriptionService = subscriptionService;
        this.devicePort = devicePort;
        this.settings = settings;
        this.codec = codec;
        this.mapper = mapper;
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession session) throws Exception {
        RealtimeSession realtimeSession = sessionOf(session);
        if (realtimeSession == null) {
            session.close(new CloseStatus(WsCloseCodes.TICKET_INVALID, "WS_TICKET_INVALID"));
            return;
        }
        RealtimeConnection connection = hub.register(realtimeSession, session);
        connection.enqueue(OutboundFrame.control(codec.hello(realtimeSession.sessionId(),
                java.time.Instant.now(), settings.heartbeatInterval().toMillis())));

        if (!devicePort.isActiveDeviceOfUser(realtimeSession.deviceId(),
                realtimeSession.userId())) {
            connection.enqueue(OutboundFrame.control(codec.sessionRevoked("DEVICE_REVOKED")));
            connection.closeAfterFlush(new CloseStatus(WsCloseCodes.FORBIDDEN,
                    "DEVICE_REVOKED"));
        }
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) {
        RealtimeSession realtimeSession = sessionOf(session);
        RealtimeConnection connection = realtimeSession == null ? null
                : hub.connection(realtimeSession.sessionId());
        if (realtimeSession == null || connection == null) {
            close(session, WsCloseCodes.TICKET_INVALID, "WS_TICKET_INVALID");
            return;
        }
        connection.touch();
        if (message.getPayloadLength() > MAX_FRAME_BYTES) {
            reject(connection, realtimeSession, ErrorCode.WS_FRAME_INVALID, "Frame too large",
                    null);
            return;
        }

        JsonNode frame;
        try {
            frame = mapper.readTree(message.getPayload());
        } catch (Exception ex) {
            reject(connection, realtimeSession, ErrorCode.WS_FRAME_INVALID, "Malformed JSON",
                    null);
            return;
        }
        if (frame == null || !frame.isObject() || !frame.has("v")
                || frame.get("v").asInt() != 1) {
            reject(connection, realtimeSession, ErrorCode.WS_FRAME_INVALID,
                    "Unsupported protocol version", null);
            return;
        }
        String type = frame.path("type").asText("");
        try {
            switch (type) {
                case "subscribe" -> subscribe(connection, realtimeSession, frame);
                case "ack" -> ack(connection, frame);
                case "ping" -> connection.enqueue(OutboundFrame.control(
                        codec.pong(java.time.Instant.now())));
                case "typing" -> typing(connection, realtimeSession, frame);
                default -> reject(connection, realtimeSession, ErrorCode.WS_FRAME_INVALID,
                        "Unknown frame type", null);
            }
        } catch (RealtimeSessionRevokedException ex) {
            connection.enqueue(OutboundFrame.control(codec.sessionRevoked("DEVICE_REVOKED")));
            connection.closeAfterFlush(new CloseStatus(WsCloseCodes.FORBIDDEN,
                    "DEVICE_REVOKED"));
        } catch (RealtimeTicketInvalidException ex) {
            connection.closeAfterFlush(new CloseStatus(WsCloseCodes.TICKET_INVALID,
                    "WS_TICKET_INVALID"));
        } catch (SubscriptionLimitExceededException ex) {
            reject(connection, realtimeSession, ErrorCode.SUBSCRIPTION_LIMIT,
                    "Subscription limit exceeded", null);
        } catch (DomainException ex) {
            reject(connection, realtimeSession, ex.code(), ex.getMessage(), null);
        } catch (RuntimeException ex) {
            log.warn("ws.frame_failed session_id={} type={} error={}",
                    realtimeSession.sessionId(), type, ex.getClass().getName());
            reject(connection, realtimeSession, ErrorCode.INTERNAL, "Internal error", null);
        }
    }

    private void subscribe(RealtimeConnection connection, RealtimeSession session,
                           JsonNode frame) {
        JsonNode chats = frame.get("chats");
        if (chats == null || !chats.isArray()) {
            reject(connection, session, ErrorCode.WS_FRAME_INVALID,
                    "chats must be an array", null);
            return;
        }
        java.util.List<ChatSubscription> requested = new java.util.ArrayList<>();
        for (JsonNode item : chats) {
            UUID chatId = uuid(item.path("chat_id").asText(null));
            if (chatId == null) {
                reject(connection, session, ErrorCode.WS_FRAME_INVALID,
                        "chat_id must be a UUID", null);
                return;
            }
            long lastSeq = item.path("last_seq").asLong(0);
            if (lastSeq < 0) {
                reject(connection, session, ErrorCode.WS_FRAME_INVALID,
                        "last_seq must be >= 0", chatId);
                return;
            }
            requested.add(new ChatSubscription(chatId, lastSeq));
        }
        boolean presence = frame.path("presence").asBoolean(false);
        SubscriptionPlan plan = subscriptionService.subscribe(session, requested, presence);
        connection.enqueue(OutboundFrame.control(codec.subscribed(plan.chats())));
        hub.activate(plan);
        if (plan.presence()) {
            List<UUID> accepted = plan.chats().stream()
                    .filter(SubscribedChat::accepted)
                    .map(SubscribedChat::chatId)
                    .toList();
            subscriptionService.presence(session, accepted, PresenceStatus.ONLINE);
        }
    }

    private void ack(RealtimeConnection connection, JsonNode frame) {
        JsonNode lastSeq = frame.get("last_seq");
        if (lastSeq == null || !lastSeq.canConvertToLong() || lastSeq.asLong() < 0) {
            connection.touch();
            connection.enqueue(OutboundFrame.control(codec.error(ErrorCode.WS_FRAME_INVALID,
                    "last_seq must be >= 0", connection.sessionId(), null)));
            return;
        }
        connection.ack(lastSeq.asLong());
    }

    private void typing(RealtimeConnection connection, RealtimeSession session,
                        JsonNode frame) {
        UUID chatId = uuid(frame.path("chat_id").asText(null));
        if (chatId == null) {
            reject(connection, session, ErrorCode.WS_FRAME_INVALID,
                    "chat_id must be a UUID", null);
            return;
        }
        subscriptionService.typing(session, chatId);
    }

    private void reject(RealtimeConnection connection, RealtimeSession session, String code,
                        String message, UUID chatId) {
        connection.enqueue(OutboundFrame.control(codec.error(code, message,
                session.sessionId(), chatId)));
        connection.closeAfterFlush(new CloseStatus(WsCloseCodes.POLICY_VIOLATION,
                "POLICY_VIOLATION"));
    }

    @Override
    protected void handlePongMessage(WebSocketSession session, PongMessage message) {
        RealtimeSession realtimeSession = sessionOf(session);
        RealtimeConnection connection = realtimeSession == null ? null
                : hub.connection(realtimeSession.sessionId());
        if (connection != null) {
            connection.touch();
        }
    }

    @Override
    public void handleTransportError(WebSocketSession session, Throwable exception) {
        RealtimeSession realtimeSession = sessionOf(session);
        if (realtimeSession != null) {
            hub.unregister(realtimeSession.sessionId());
        }
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        RealtimeSession realtimeSession = sessionOf(session);
        if (realtimeSession == null) {
            return;
        }
        RealtimeConnection connection = hub.connection(realtimeSession.sessionId());
        if (connection != null && connection.presenceEnabled()) {
            try {
                subscriptionService.presence(realtimeSession, connection.chats(),
                        PresenceStatus.OFFLINE);
            } catch (RuntimeException ex) {
                log.debug("ws.presence_offline_failed session_id={}",
                        realtimeSession.sessionId());
            }
        }
        hub.unregister(realtimeSession.sessionId());
    }

    private static RealtimeSession sessionOf(WebSocketSession session) {
        Object value = session.getAttributes().get(RealtimeSession.ATTRIBUTE);
        return value instanceof RealtimeSession realtimeSession ? realtimeSession : null;
    }

    private static UUID uuid(String value) {
        if (value == null) {
            return null;
        }
        try {
            return UUID.fromString(value);
        } catch (IllegalArgumentException ex) {
            return null;
        }
    }

    private static void close(WebSocketSession session, int code, String reason) {
        try {
            if (session.isOpen()) {
                session.close(new CloseStatus(code, reason));
            }
        } catch (Exception ex) {
            // peer is already gone
        }
    }
}
