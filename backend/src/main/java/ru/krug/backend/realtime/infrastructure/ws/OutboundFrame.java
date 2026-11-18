package ru.krug.backend.realtime.infrastructure.ws;

import java.util.UUID;

/**
 * One outbound item. Control frames (heartbeat ping) live in the same bounded queue so a
 * single writer task is the only thread calling {@code WebSocketSession.sendMessage}.
 */
public record OutboundFrame(String json, boolean ephemeral, UUID chatId, Long seq,
                            boolean ping) {

    public static OutboundFrame text(String json, boolean ephemeral, UUID chatId, Long seq) {
        return new OutboundFrame(json, ephemeral, chatId, seq, false);
    }

    public static OutboundFrame control(String json) {
        return new OutboundFrame(json, false, null, null, false);
    }

    public static OutboundFrame heartbeat() {
        return new OutboundFrame(null, false, null, null, true);
    }
}
