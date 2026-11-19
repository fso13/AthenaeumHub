package ru.krug.backend.realtime.infrastructure.ws;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.stereotype.Component;

import ru.krug.backend.realtime.application.model.CallKind;
import ru.krug.backend.realtime.application.model.CallSignalRelay;
import ru.krug.backend.realtime.application.model.EphemeralEvent;
import ru.krug.backend.realtime.application.model.RealtimeEvent;
import ru.krug.backend.realtime.application.model.RealtimeGap;
import ru.krug.backend.realtime.application.model.SubscribedChat;

/** Serialises WS protocol v1 frames. Field names are exactly the contract's snake_case. */
@Component
public class WsFrameCodec {

    private final ObjectMapper mapper;

    public WsFrameCodec(ObjectMapper mapper) {
        this.mapper = mapper;
    }

    public String hello(String sessionId, Instant serverTime, long heartbeatMs) {
        ObjectNode node = base("hello");
        node.put("session_id", sessionId);
        node.put("server_time", serverTime.toString());
        node.put("heartbeat_ms", heartbeatMs);
        node.put("protocol", "krug.ws.v1");
        return write(node);
    }

    public String subscribed(List<SubscribedChat> chats) {
        ObjectNode node = base("subscribed");
        ArrayNode array = node.putArray("chats");
        for (SubscribedChat chat : chats) {
            ObjectNode item = array.addObject();
            item.put("chat_id", chat.chatId().toString());
            item.put("accepted", chat.accepted());
            item.put("server_last_seq", chat.serverLastSeq());
            if (chat.reason() != null) {
                item.put("reason", chat.reason());
            }
        }
        return write(node);
    }

    public String event(RealtimeEvent event) {
        return write(eventNode(event, null));
    }

    /**
     * Per-device frame: when the event carries per-recipient envelopes, only the envelope
     * of {@code deviceId} is placed into {@code payload.crypto}. A connection without an
     * envelope (for example the sender's own device) gets {@code crypto:null}; the map
     * itself never reaches the wire.
     */
    public String event(RealtimeEvent event, UUID deviceId) {
        return write(eventNode(event, deviceId));
    }

    private ObjectNode eventNode(RealtimeEvent event, UUID deviceId) {
        ObjectNode node = base("event");
        node.put("event_id", event.eventId().toString());
        node.put("event", event.event());
        node.put("workspace_id", event.workspaceId().toString());
        node.put("chat_id", event.chatId().toString());
        node.put("seq", event.seq());
        node.put("ts", event.ts().toString());
        ObjectNode payload = mapper.valueToTree(event.payload());
        if (!event.cryptoByDevice().isEmpty()) {
            Object crypto = event.cryptoByDevice().get(deviceId);
            if (crypto == null) {
                payload.putNull("crypto");
            } else {
                payload.set("crypto", mapper.valueToTree(crypto));
            }
        }
        node.set("payload", payload);
        return node;
    }

    public String ephemeral(EphemeralEvent event) {
        ObjectNode node = base("event");
        node.put("event", event.event());
        node.put("workspace_id", event.workspaceId().toString());
        node.put("chat_id", event.chatId().toString());
        node.put("ts", event.ts().toString());
        node.set("payload", mapper.valueToTree(event.payload()));
        return write(node);
    }

    /** {@code chat.keys.changed}: metadata only, no event_id/seq, never replayed. */
    public String keyChanged(java.util.UUID workspaceId, java.util.UUID chatId, String reason,
                             java.util.UUID deviceId, Integer keyGeneration, Instant ts) {
        ObjectNode node = base("event");
        node.put("event", "chat.keys.changed");
        node.put("workspace_id", workspaceId.toString());
        node.put("chat_id", chatId.toString());
        node.put("ts", ts.toString());
        ObjectNode payload = node.putObject("payload");
        payload.put("chat_id", chatId.toString());
        payload.put("reason", reason);
        if (deviceId != null) {
            payload.put("device_id", deviceId.toString());
        }
        if (keyGeneration != null) {
            payload.put("key_generation", keyGeneration);
        }
        return write(node);
    }

    /** {@code device.list.changed}: owner-only, no chat scope, no event_id/seq. */
    public String deviceListChanged(java.util.UUID workspaceId, java.util.UUID deviceId,
                                    String status, int keyGeneration, Instant ts) {
        ObjectNode node = base("event");
        node.put("event", "device.list.changed");
        if (workspaceId != null) {
            node.put("workspace_id", workspaceId.toString());
        }
        node.put("ts", ts.toString());
        ObjectNode payload = node.putObject("payload");
        payload.put("device_id", deviceId.toString());
        payload.put("status", status);
        payload.put("key_generation", keyGeneration);
        return write(node);
    }

    public String gap(RealtimeGap gap) {
        ObjectNode node = base("resume.gap");
        node.put("chat_id", gap.chatId().toString());
        node.put("from_seq", gap.fromSeq());
        node.put("to_seq", gap.toSeq());
        node.put("reason", gap.reason());
        return write(node);
    }

    /**
     * Ephemeral {@code call.signal}: the validated payload is relayed byte-for-byte plus
     * the authenticated sender ids. No event_id/seq, no persistence, no replay.
     *
     * <p>A GROUP conference frame additionally carries {@code conference=true} and the
     * validated recipient list; a DIRECT frame keeps the original payload shape and omits
     * both keys, so existing 1:1 clients are unaffected.
     */
    public String callSignal(CallSignalRelay relay) {
        ObjectNode node = base("event");
        node.put("event", "call.signal");
        node.put("workspace_id", relay.workspaceId().toString());
        node.put("chat_id", relay.chatId().toString());
        node.put("ts", relay.ts().toString());
        node.put("from_user_id", relay.fromUserId().toString());
        node.put("from_device_id", relay.fromDeviceId().toString());
        ObjectNode payload = node.putObject("payload");
        payload.put("call_id", relay.signal().callId().toString());
        payload.put("kind", relay.signal().kind().wire());
        payload.put("video", relay.signal().video());
        if (relay.signal().conference()) {
            payload.put("conference", true);
            ArrayNode recipients = payload.putArray("recipients");
            for (UUID recipient : relay.signal().recipients()) {
                recipients.add(recipient.toString());
            }
        }
        if (relay.signal().sdp() != null) {
            payload.put("sdp", relay.signal().sdp());
        }
        if (relay.signal().candidate() != null) {
            payload.set("candidate", mapper.valueToTree(relay.signal().candidate()));
        }
        return write(node);
    }

    /**
     * Caller-only, ephemeral: zero live sessions among the frame's recipients (the DIRECT
     * peer, or every named GROUP recipient). A partial GROUP delivery is not an error.
     */
    public String callUnavailable(UUID workspaceId, UUID chatId, UUID callId, CallKind kind,
                                  String reason, Instant ts) {
        ObjectNode node = base("event");
        node.put("event", "call.unavailable");
        if (workspaceId != null) {
            node.put("workspace_id", workspaceId.toString());
        }
        node.put("chat_id", chatId.toString());
        node.put("ts", ts.toString());
        ObjectNode payload = node.putObject("payload");
        payload.put("call_id", callId.toString());
        payload.put("kind", kind.wire());
        payload.put("reason", reason);
        return write(node);
    }

    public String pong(Instant serverTime) {
        ObjectNode node = base("pong");
        node.put("server_time", serverTime.toString());
        return write(node);
    }

    public String error(String code, String message, String requestId, UUID chatId) {
        return error(code, message, requestId, chatId, null);
    }

    /**
     * Error frame with an optional semantic HTTP-like status. Call signalling uses 400/403/
     * 413/422/429; other WS errors keep the legacy shape without {@code status}.
     */
    public String error(String code, String message, String requestId, UUID chatId,
                        Integer status) {
        ObjectNode node = base("error");
        node.put("code", code);
        node.put("message", message);
        node.put("request_id", requestId);
        if (chatId != null) {
            node.put("chat_id", chatId.toString());
        }
        if (status != null) {
            node.put("status", status);
        }
        return write(node);
    }

    public String sessionRevoked(String reason) {
        ObjectNode node = base("session.revoked");
        node.put("reason", reason);
        return write(node);
    }

    private ObjectNode base(String type) {
        ObjectNode node = mapper.createObjectNode();
        node.put("v", 1);
        node.put("type", type);
        return node;
    }

    private String write(ObjectNode node) {
        try {
            return mapper.writeValueAsString(node);
        } catch (com.fasterxml.jackson.core.JsonProcessingException ex) {
            throw new IllegalStateException("Cannot serialise a WS frame", ex);
        }
    }
}
