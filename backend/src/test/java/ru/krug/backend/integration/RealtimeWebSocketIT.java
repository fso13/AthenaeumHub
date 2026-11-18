package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.net.http.WebSocketHandshakeException;
import java.time.Duration;
import java.util.UUID;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.CompletionException;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.ActiveProfiles;

import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.realtime.domain.model.TicketToken;
import ru.krug.backend.shared.application.model.IssuedToken;
import ru.krug.backend.shared.application.port.TokenIssuer;
import ru.krug.backend.support.WebSocketIntegrationTestBase;

@ActiveProfiles("test")
class RealtimeWebSocketIT extends WebSocketIntegrationTestBase {

    private static final Duration TIMEOUT = Duration.ofSeconds(8);

    @Autowired
    private TokenIssuer tokenIssuer;

    @Test
    void helloSubscribeReplayAndOneTimeTicket() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();
        sendMessage(session, chatId, "first", UUID.randomUUID().toString());
        sendMessage(session, chatId, "second", UUID.randomUUID().toString());
        String ticket = ticket(session).get("ticket").asText();

        WebSocketClient client = connect(ticket);
        JsonNode hello = client.awaitType("hello", TIMEOUT);
        assertThat(hello.get("session_id").asText()).startsWith("ws_");
        assertThat(hello.get("heartbeat_ms").asLong()).isEqualTo(25_000);
        assertThat(hello.get("protocol").asText()).isEqualTo("krug.ws.v1");

        client.send(subscribeFrame(chatId, 0, false));
        JsonNode subscribed = client.awaitType("subscribed", TIMEOUT);
        assertThat(subscribed.get("chats").get(0).get("accepted").asBoolean()).isTrue();
        assertThat(subscribed.get("chats").get(0).get("server_last_seq").asLong()).isEqualTo(2);

        JsonNode event1 = client.awaitEvent("message.created", TIMEOUT);
        JsonNode event2 = client.awaitEvent("message.created", TIMEOUT);
        assertThat(event1.get("seq").asLong()).isEqualTo(1);
        assertThat(event2.get("seq").asLong()).isEqualTo(2);
        assertThat(event1.get("payload").get("text").asText()).isEqualTo("first");
        assertThat(event2.get("payload").get("text").asText()).isEqualTo("second");
        client.close();

        // The ticket was consumed during the first handshake and cannot be reused.
        assertThatThrownBy(() -> connect(ticket))
                .isInstanceOf(CompletionException.class)
                .hasCauseInstanceOf(WebSocketHandshakeException.class)
                .satisfies(ex -> assertThat(
                        ((WebSocketHandshakeException) ex.getCause()).getResponse()
                                .statusCode()).isEqualTo(401));
    }

    @Test
    void liveMessageAndReadReceiptBetweenTwoUsers() throws Exception {
        SessionResponse alice = devSession();
        SessionResponse bob = devSession();
        UUID chatId = alice.chat().id();
        addMember(alice, bob);
        SessionResponse bobInAliceChat = scoped(bob, alice);

        WebSocketClient aliceWs = connect(ticket(alice).get("ticket").asText());
        aliceWs.awaitType("hello", TIMEOUT);
        aliceWs.send(subscribeFrame(chatId, 0, false));
        aliceWs.awaitType("subscribed", TIMEOUT);

        WebSocketClient bobWs = connect(ticket(bobInAliceChat).get("ticket").asText());
        bobWs.awaitType("hello", TIMEOUT);
        bobWs.send(subscribeFrame(chatId, 0, false));
        bobWs.awaitType("subscribed", TIMEOUT);

        sendMessage(bobInAliceChat, chatId, "from bob", UUID.randomUUID().toString());

        JsonNode live = aliceWs.awaitEvent("message.created", TIMEOUT);
        assertThat(live.get("seq").asLong()).isEqualTo(1);
        assertThat(live.get("payload").get("sender_id").asText())
                .isEqualTo(bob.user().id().toString());
        assertThat(live.get("payload").get("text").asText()).isEqualTo("from bob");

        ResponseEntity<String> read = markRead(alice, chatId, 1);
        assertThat(read.getStatusCode().value()).isEqualTo(204);

        JsonNode receipt = bobWs.awaitEvent("message.receipt", TIMEOUT);
        assertThat(receipt.get("payload").get("user_id").asText())
                .isEqualTo(alice.user().id().toString());
        assertThat(receipt.get("payload").get("last_read_seq").asLong()).isEqualTo(1);

        // Reconnect with a fresh ticket and last_seq=1: no replay duplicates, then only seq 2.
        aliceWs.close();
        String freshTicket = ticket(alice).get("ticket").asText();
        WebSocketClient reconnected = connect(freshTicket);
        reconnected.awaitType("hello", TIMEOUT);
        reconnected.send(subscribeFrame(chatId, 1, false));
        JsonNode resubscribed = reconnected.awaitType("subscribed", TIMEOUT);
        assertThat(resubscribed.get("chats").get(0).get("server_last_seq").asLong()).isEqualTo(1);
        assertThat(reconnected.awaitEventWithin("message.created", Duration.ofMillis(400))).isNull();

        sendMessage(bobInAliceChat, chatId, "second", UUID.randomUUID().toString());
        JsonNode second = reconnected.awaitEvent("message.created", TIMEOUT);
        assertThat(second.get("seq").asLong()).isEqualTo(2);
        assertThat(second.get("payload").get("text").asText()).isEqualTo("second");
        reconnected.close();
        bobWs.close();
    }

    @Test
    void liveAndReplayedStickerEventsCarryRenderingMetadata() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();

        // Sent before connecting: the first event must come from the replay adapter.
        sendSticker(session, chatId, ru.krug.backend.support.StickerTestSupport.KRUG_01,
                UUID.randomUUID().toString());

        WebSocketClient client = connect(ticket(session).get("ticket").asText());
        client.awaitType("hello", TIMEOUT);
        client.send(subscribeFrame(chatId, 0, false));
        JsonNode subscribed = client.awaitType("subscribed", TIMEOUT);
        assertThat(subscribed.get("chats").get(0).get("accepted").asBoolean()).isTrue();

        JsonNode replay = client.awaitEvent("message.created", TIMEOUT);
        assertStickerPayload(replay, ru.krug.backend.support.StickerTestSupport.KRUG_01);
        assertThat(replay.get("seq").asLong()).isEqualTo(1);

        sendSticker(session, chatId, ru.krug.backend.support.StickerTestSupport.CATS_01,
                UUID.randomUUID().toString());
        JsonNode live = client.awaitEvent("message.created", TIMEOUT);
        assertStickerPayload(live, ru.krug.backend.support.StickerTestSupport.CATS_01);
        assertThat(live.get("seq").asLong()).isEqualTo(2);
        client.close();
    }

    @Test
    void messageCreatedCarriesThreadRootIdLiveAndOnReplay() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();
        JsonNode root = sendMessage(session, chatId, "root", UUID.randomUUID().toString());
        UUID rootId = UUID.fromString(root.get("id").asText());

        WebSocketClient client = connect(ticket(session).get("ticket").asText());
        client.awaitType("hello", TIMEOUT);
        client.send(subscribeFrame(chatId, 0, false));
        client.awaitType("subscribed", TIMEOUT);

        JsonNode replayedRoot = client.awaitEvent("message.created", TIMEOUT);
        assertThat(replayedRoot.get("payload").get("thread_root_id").isNull()).isTrue();

        JsonNode reply = sendMessage(session, chatId, "reply", UUID.randomUUID().toString(),
                rootId);
        JsonNode live = client.awaitEvent("message.created", TIMEOUT);
        assertThat(live.get("seq").asLong()).isEqualTo(2);
        assertThat(live.get("payload").get("id").asText())
                .isEqualTo(reply.get("id").asText());
        assertThat(live.get("payload").get("thread_root_id").asText())
                .isEqualTo(rootId.toString());
        client.close();

        // Replay from last_seq=1 includes the reply and keeps the same thread root.
        WebSocketClient reconnected = connect(ticket(session).get("ticket").asText());
        reconnected.awaitType("hello", TIMEOUT);
        reconnected.send(subscribeFrame(chatId, 1, false));
        reconnected.awaitType("subscribed", TIMEOUT);
        JsonNode replayReply = reconnected.awaitEvent("message.created", TIMEOUT);
        assertThat(replayReply.get("seq").asLong()).isEqualTo(2);
        assertThat(replayReply.get("payload").get("thread_root_id").asText())
                .isEqualTo(rootId.toString());
        reconnected.close();
    }

    private static void assertStickerPayload(JsonNode event, UUID stickerId) {
        JsonNode payload = event.get("payload");
        assertThat(payload.get("type").asText()).isEqualTo("STICKER");
        assertThat(payload.get("text").isNull()).isTrue();
        assertThat(payload.get("attachments").size()).isZero();
        assertThat(payload.get("sticker_id").asText()).isEqualTo(stickerId.toString());
        assertThat(payload.get("sticker").get("id").asText()).isEqualTo(stickerId.toString());
        assertThat(payload.get("sticker").get("pack_id").asText()).isNotBlank();
        assertThat(payload.get("sticker").get("alt").asText()).isNotBlank();
        assertThat(payload.get("sticker").get("url").asText()).startsWith("/stickers/");
        assertThat(payload.get("sticker").get("favorite").asBoolean()).isFalse();
    }

    @Test
    void foreignChatIsDeniedWithoutLeak() throws Exception {
        SessionResponse alice = devSession();
        SessionResponse bob = devSession();

        WebSocketClient aliceWs = connect(ticket(alice).get("ticket").asText());
        aliceWs.awaitType("hello", TIMEOUT);
        aliceWs.send(subscribeFrame(bob.chat().id(), 0, false));
        JsonNode subscribed = aliceWs.awaitType("subscribed", TIMEOUT);

        assertThat(subscribed.get("chats").get(0).get("accepted").asBoolean()).isFalse();
        assertThat(subscribed.get("chats").get(0).get("reason").asText())
                .isEqualTo("FORBIDDEN");
        assertThat(aliceWs.awaitEventWithin("message.created", Duration.ofMillis(300))).isNull();
        aliceWs.close();
    }

    @Test
    void foreignOriginIsRejectedBeforeUpgrade() throws Exception {
        SessionResponse session = devSession();
        String ticket = ticket(session).get("ticket").asText();

        assertThatThrownBy(() -> connect(ticket, "http://evil.example"))
                .isInstanceOf(CompletionException.class)
                .hasCauseInstanceOf(WebSocketHandshakeException.class)
                .satisfies(ex -> assertThat(
                        ((WebSocketHandshakeException) ex.getCause()).getResponse()
                                .statusCode()).isEqualTo(403));

        // The rejected origin must not have consumed the one-time ticket.
        WebSocketClient allowed = connect(ticket, "http://localhost:5173");
        assertThat(allowed.awaitType("hello", TIMEOUT).get("type").asText()).isEqualTo("hello");
        allowed.close();
    }

    @Test
    void viteDevOriginIsAllowed() throws Exception {
        SessionResponse session = devSession();
        String ticket = ticket(session).get("ticket").asText();

        WebSocketClient client = connect(ticket, "http://localhost:5173");
        JsonNode hello = client.awaitType("hello", TIMEOUT);
        assertThat(hello.get("type").asText()).isEqualTo("hello");
        client.close();
    }

    @Test
    void expiredTicketIsRejectedBeforeUpgrade() throws Exception {
        SessionResponse session = devSession();
        String ticket = ticket(session).get("ticket").asText();
        String hash = TicketToken.of(ticket).hash().value();
        migrator().update("UPDATE realtime.realtime_tickets"
                + " SET issued_at = now() - interval '31 seconds',"
                + " expires_at = now() - interval '1 second' WHERE token_hash = ?", hash);

        assertThatThrownBy(() -> connect(ticket))
                .isInstanceOf(CompletionException.class)
                .hasCauseInstanceOf(WebSocketHandshakeException.class)
                .satisfies(ex -> assertThat(
                        ((WebSocketHandshakeException) ex.getCause()).getResponse()
                                .statusCode()).isEqualTo(401));
    }

    @Test
    void websocketWithoutTicketIsRejected() {
        assertThatThrownBy(() -> connect(null))
                .isInstanceOf(CompletionException.class)
                .hasCauseInstanceOf(WebSocketHandshakeException.class)
                .satisfies(ex -> assertThat(
                        ((WebSocketHandshakeException) ex.getCause()).getResponse()
                                .statusCode()).isEqualTo(401));
    }

    private SessionResponse scoped(SessionResponse user, SessionResponse resource) {
        IssuedToken token = tokenIssuer.issue(user.user().id(), user.device().id(),
                resource.workspace().id());
        return new SessionResponse(token.accessToken(), token.expiresAt(), user.user(),
                user.device(), resource.workspace(), resource.chat());
    }

    private void addMember(SessionResponse owner, SessionResponse member) {
        migrator().update("""
                INSERT INTO workspace.memberships (workspace_id, user_id, role, status)
                VALUES (?, ?, 'MEMBER', 'ACTIVE')
                ON CONFLICT (workspace_id, user_id)
                DO UPDATE SET status = 'ACTIVE'
                """, owner.workspace().id(), member.user().id());
        migrator().update("""
                INSERT INTO chat.chat_members (chat_id, workspace_id, user_id, role, status)
                VALUES (?, ?, ?, 'MEMBER', 'ACTIVE')
                ON CONFLICT (chat_id, user_id)
                DO UPDATE SET status = 'ACTIVE'
                """, owner.chat().id(), owner.workspace().id(), member.user().id());
    }

    private String subscribeFrame(UUID chatId, long lastSeq, boolean presence) {
        return "{\"v\":1,\"type\":\"subscribe\",\"chats\":[{\"chat_id\":\""
                + chatId + "\",\"last_seq\":" + lastSeq + "}],\"presence\":" + presence + "}";
    }

    private WebSocketClient connect(String ticket) {
        return connect(ticket, null);
    }

    private WebSocketClient connect(String ticket, String origin) {
        try {
            WebSocketClient listener = new WebSocketClient(objectMapper);
            URI uri = URI.create("ws://localhost:" + port + "/ws"
                    + (ticket == null ? "" : "?ticket=" + ticket));
            WebSocket.Builder builder = HttpClient.newHttpClient().newWebSocketBuilder()
                    .connectTimeout(Duration.ofSeconds(5));
            if (origin != null) {
                builder.header("Origin", origin);
            }
            WebSocket socket = builder.buildAsync(uri, listener).join();
            listener.attach(socket);
            return listener;
        } catch (CompletionException ex) {
            throw ex;
        }
    }

    /** Minimal blocking WS client for the integration tests. */
    private static final class WebSocketClient implements WebSocket.Listener {

        private final ObjectMapper mapper;
        private final BlockingQueue<JsonNode> frames = new LinkedBlockingQueue<>();
        private final StringBuilder buffer = new StringBuilder();
        private volatile WebSocket socket;
        private volatile int closeCode = -1;

        private WebSocketClient(ObjectMapper mapper) {
            this.mapper = mapper;
        }

        private void attach(WebSocket webSocket) {
            this.socket = webSocket;
        }

        @Override
        public void onOpen(WebSocket webSocket) {
            this.socket = webSocket;
            webSocket.request(1);
        }

        @Override
        public CompletionStage<?> onText(WebSocket webSocket, CharSequence data, boolean last) {
            buffer.append(data);
            if (last) {
                try {
                    frames.add(mapper.readTree(buffer.toString()));
                } catch (Exception ex) {
                    throw new IllegalStateException("bad WS frame", ex);
                }
                buffer.setLength(0);
            }
            webSocket.request(1);
            return null;
        }

        @Override
        public CompletionStage<?> onClose(WebSocket webSocket, int statusCode, String reason) {
            closeCode = statusCode;
            return null;
        }

        void send(String json) {
            socket.sendText(json, true).join();
        }

        JsonNode awaitType(String type, Duration timeout) {
            return await(frame -> type.equals(frame.path("type").asText()), timeout);
        }

        JsonNode awaitEvent(String event, Duration timeout) {
            return await(frame -> "event".equals(frame.path("type").asText())
                    && event.equals(frame.path("event").asText()), timeout);
        }

        JsonNode awaitEventWithin(String event, Duration timeout) {
            try {
                return awaitEvent(event, timeout);
            } catch (AssertionError ex) {
                return null;
            }
        }

        private JsonNode await(java.util.function.Predicate<JsonNode> predicate,
                               Duration timeout) {
            long deadline = System.nanoTime() + timeout.toNanos();
            while (System.nanoTime() < deadline) {
                long remaining = Math.max(1,
                        TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime()));
                JsonNode frame;
                try {
                    frame = frames.poll(remaining, TimeUnit.MILLISECONDS);
                } catch (InterruptedException ex) {
                    Thread.currentThread().interrupt();
                    throw new AssertionError("interrupted while waiting for WS frame", ex);
                }
                if (frame != null && predicate.test(frame)) {
                    return frame;
                }
            }
            throw new AssertionError("WS frame was not received: " + frames);
        }

        void close() {
            WebSocket current = socket;
            if (current != null) {
                current.sendClose(WebSocket.NORMAL_CLOSURE, "test done")
                        .exceptionally(ex -> null)
                        .join();
            }
        }

        int closeCode() {
            return closeCode;
        }
    }
}
