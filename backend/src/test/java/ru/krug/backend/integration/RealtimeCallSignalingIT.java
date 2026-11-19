package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.TestPropertySource;

import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.shared.application.model.IssuedToken;
import ru.krug.backend.shared.application.port.TokenIssuer;
import ru.krug.backend.support.WebSocketIntegrationTestBase;

/**
 * End-to-end WS tests for 1:1 call signalling. A low per-session signal limit keeps the
 * rate-limit assertion fast; each test uses fresh sessions, so the window never leaks.
 */
@ActiveProfiles("test")
@TestPropertySource(properties = "krug.realtime.call-signal-limit=8")
class RealtimeCallSignalingIT extends WebSocketIntegrationTestBase {

    private static final Duration TIMEOUT = Duration.ofSeconds(8);

    @Autowired
    private TokenIssuer tokenIssuer;

    @Test
    void offerAnswerIceBusyRelayBetweenTwoSessionsWithoutSeqOrReplay() throws Exception {
        SessionResponse alice = devSession();
        SessionResponse bob = devSession();
        Room room = directRoom(alice, bob);

        WebSocketClient aliceWs = connectAndSubscribe(alice, room.chatId());
        WebSocketClient bobWs = connectAndSubscribe(room.bob(), room.chatId());

        UUID callId = UUID.randomUUID();
        String sdpMarker = "SDP-MARKER-" + UUID.randomUUID();
        String candidateMarker = "CAND-MARKER-" + UUID.randomUUID();

        LogCapture logs = attachLogCapture();
        try {
            aliceWs.send(signalFrame(room.chatId(), callId, "offer", true,
                    "v=0\r\na=x-marker:" + sdpMarker + "\r\n", null));
            JsonNode offer = bobWs.awaitEvent("call.signal", TIMEOUT);
            assertThat(offer.get("type").asText()).isEqualTo("event");
            assertThat(offer.has("seq")).isFalse();
            assertThat(offer.has("event_id")).isFalse();
            assertThat(offer.get("chat_id").asText()).isEqualTo(room.chatId().toString());
            JsonNode offerPayload = offer.get("payload");
            assertThat(offerPayload.get("call_id").asText()).isEqualTo(callId.toString());
            assertThat(offerPayload.get("kind").asText()).isEqualTo("offer");
            assertThat(offerPayload.get("video").asBoolean()).isTrue();
            assertThat(offerPayload.get("sdp").asText()).contains(sdpMarker);
            assertThat(offer.get("from_user_id").asText())
                    .isEqualTo(alice.user().id().toString());
            assertThat(offer.get("from_device_id").asText())
                    .isEqualTo(alice.device().id().toString());

            bobWs.send(signalFrame(room.chatId(), callId, "answer", true,
                    "v=0\r\na=answer\r\n", null));
            JsonNode answer = aliceWs.awaitEvent("call.signal", TIMEOUT);
            assertThat(answer.get("payload").get("kind").asText()).isEqualTo("answer");
            assertThat(answer.get("from_user_id").asText())
                    .isEqualTo(bob.user().id().toString());

            JsonNode candidate = objectMapper.readTree("{\"candidate\":\"candidate:1 1 UDP"
                    + " 2122260223 203.0.113.7 50000 typ host " + candidateMarker
                    + "\",\"sdp_mid\":\"0\",\"sdp_mline_index\":0}");
            aliceWs.send(signalFrame(room.chatId(), callId, "ice", true, null, candidate));
            JsonNode aliceIce = bobWs.awaitEvent("call.signal", TIMEOUT);
            assertThat(aliceIce.get("payload").get("kind").asText()).isEqualTo("ice");
            assertThat(aliceIce.get("payload").get("candidate").get("candidate").asText())
                    .contains(candidateMarker);

            bobWs.send(signalFrame(room.chatId(), callId, "ice", true, null, candidate));
            JsonNode bobIce = aliceWs.awaitEvent("call.signal", TIMEOUT);
            assertThat(bobIce.get("from_user_id").asText())
                    .isEqualTo(bob.user().id().toString());

            bobWs.send(signalFrame(room.chatId(), callId, "busy", false, null, null));
            JsonNode busy = aliceWs.awaitEvent("call.signal", TIMEOUT);
            assertThat(busy.get("payload").get("kind").asText()).isEqualTo("busy");
            assertThat(busy.get("payload").has("sdp")).isFalse();
            assertThat(busy.get("payload").has("candidate")).isFalse();
        } finally {
            logs.close();
        }

        List<String> messages = capturedMessages(logs.appender());
        assertThat(messages).noneMatch(message -> message.contains(sdpMarker));
        assertThat(messages).noneMatch(message -> message.contains(candidateMarker));
        assertThat(messages).noneMatch(message -> message.contains("203.0.113.7"));

        // Signalling is ephemeral: a fresh subscription replays messages only.
        aliceWs.close();
        WebSocketClient reconnected = connect(ticket(alice).get("ticket").asText());
        reconnected.awaitType("hello", TIMEOUT);
        reconnected.send(subscribeFrame(room.chatId(), 0, false));
        reconnected.awaitType("subscribed", TIMEOUT);
        assertThat(reconnected.awaitEventWithin("call.signal", Duration.ofMillis(400))).isNull();
        reconnected.close();
        bobWs.close();
    }

    @Test
    void offlinePeerProducesCallUnavailableToCallerOnly() throws Exception {
        SessionResponse alice = devSession();
        SessionResponse bob = devSession();
        Room room = directRoom(alice, bob);

        WebSocketClient aliceWs = connectAndSubscribe(alice, room.chatId());
        UUID callId = UUID.randomUUID();

        aliceWs.send(signalFrame(room.chatId(), callId, "offer", true,
                "v=0\r\na=offline\r\n", null));

        JsonNode unavailable = aliceWs.awaitEvent("call.unavailable", TIMEOUT);
        assertThat(unavailable.has("seq")).isFalse();
        assertThat(unavailable.has("event_id")).isFalse();
        assertThat(unavailable.get("chat_id").asText()).isEqualTo(room.chatId().toString());
        JsonNode payload = unavailable.get("payload");
        assertThat(payload.get("call_id").asText()).isEqualTo(callId.toString());
        assertThat(payload.get("kind").asText()).isEqualTo("offer");
        assertThat(payload.get("reason").asText()).isEqualTo("PEER_OFFLINE");
        assertThat(aliceWs.awaitEventWithin("call.signal", Duration.ofMillis(300))).isNull();
        aliceWs.close();
    }

    @Test
    void nonDirectForeignAndNonMemberChatsAreRejectedWithoutClosingTheSocket() throws Exception {
        SessionResponse alice = devSession();
        SessionResponse bob = devSession();
        Room room = directRoom(alice, bob);
        SessionResponse carol = devSession();
        addWorkspaceMember(alice, carol.user().id());
        SessionResponse carolInAliceWorkspace = scoped(carol, alice);

        WebSocketClient aliceWs = connectAndSubscribe(alice, room.chatId());
        WebSocketClient bobWs = connectAndSubscribe(room.bob(), room.chatId());
        WebSocketClient carolWs = connect(ticket(carolInAliceWorkspace).get("ticket").asText());
        carolWs.awaitType("hello", TIMEOUT);

        UUID callId = UUID.randomUUID();
        // GROUP chat -> CALL_NOT_SUPPORTED 422.
        aliceWs.send(signalFrame(alice.chat().id(), callId, "offer", true,
                "v=0\r\na=group\r\n", null));
        JsonNode groupError = aliceWs.awaitType("error", TIMEOUT);
        assertThat(groupError.get("code").asText()).isEqualTo("CALL_NOT_SUPPORTED");
        assertThat(groupError.get("status").asInt()).isEqualTo(422);
        assertThat(groupError.get("chat_id").asText()).isEqualTo(alice.chat().id().toString());

        // A call frame error is recoverable: the socket still answers ping.
        aliceWs.send("{\"v\":1,\"type\":\"ping\",\"client_time\":\"2026-11-19T10:00:00Z\"}");
        assertThat(aliceWs.awaitType("pong", TIMEOUT).get("type").asText()).isEqualTo("pong");

        // Foreign chat (another workspace) -> FORBIDDEN 403, no existence leak.
        aliceWs.send(signalFrame(bob.chat().id(), callId, "offer", true,
                "v=0\r\na=foreign\r\n", null));
        JsonNode foreignError = aliceWs.awaitType("error", TIMEOUT);
        assertThat(foreignError.get("code").asText()).isEqualTo("FORBIDDEN");
        assertThat(foreignError.get("status").asInt()).isEqualTo(403);

        // Workspace member without chat membership -> FORBIDDEN 403.
        carolWs.send(signalFrame(room.chatId(), callId, "offer", true,
                "v=0\r\na=non-member\r\n", null));
        JsonNode memberError = carolWs.awaitType("error", TIMEOUT);
        assertThat(memberError.get("code").asText()).isEqualTo("FORBIDDEN");
        assertThat(memberError.get("status").asInt()).isEqualTo(403);

        assertThat(bobWs.awaitEventWithin("call.signal", Duration.ofMillis(400))).isNull();
        aliceWs.close();
        bobWs.close();
        carolWs.close();
    }

    @Test
    void oversizedSdpCandidateAndMalformedKindsAreRejected() throws Exception {
        SessionResponse alice = devSession();
        SessionResponse bob = devSession();
        Room room = directRoom(alice, bob);

        WebSocketClient aliceWs = connectAndSubscribe(alice, room.chatId());
        WebSocketClient bobWs = connectAndSubscribe(room.bob(), room.chatId());

        UUID callId = UUID.randomUUID();
        String oversizedSdp = "v=0\r\n" + "a".repeat(33_000);
        aliceWs.send(signalFrame(room.chatId(), callId, "offer", true, oversizedSdp, null));
        JsonNode sdpError = aliceWs.awaitType("error", TIMEOUT);
        assertThat(sdpError.get("code").asText()).isEqualTo("CALL_PAYLOAD_TOO_LARGE");
        assertThat(sdpError.get("status").asInt()).isEqualTo(413);

        String bigCandidate = "candidate:" + "x".repeat(5_000);
        JsonNode candidate = objectMapper.readTree(objectMapper.writeValueAsString(
                Map.of("candidate", bigCandidate)));
        aliceWs.send(signalFrame(room.chatId(), callId, "ice", true, null, candidate));
        JsonNode candidateError = aliceWs.awaitType("error", TIMEOUT);
        assertThat(candidateError.get("code").asText()).isEqualTo("CALL_PAYLOAD_TOO_LARGE");
        assertThat(candidateError.get("status").asInt()).isEqualTo(413);

        aliceWs.send(signalFrame(room.chatId(), callId, "conference", true,
                "v=0\r\n", null));
        JsonNode kindError = aliceWs.awaitType("error", TIMEOUT);
        assertThat(kindError.get("code").asText()).isEqualTo("WS_FRAME_INVALID");
        assertThat(kindError.get("status").asInt()).isEqualTo(400);

        ObjectNode noVideo = (ObjectNode) objectMapper.readTree(
                signalFrame(room.chatId(), callId, "offer", true, "v=0\r\n", null));
        ((ObjectNode) noVideo.get("payload")).remove("video");
        aliceWs.send(objectMapper.writeValueAsString(noVideo));
        JsonNode videoError = aliceWs.awaitType("error", TIMEOUT);
        assertThat(videoError.get("code").asText()).isEqualTo("WS_FRAME_INVALID");

        aliceWs.send("{\"v\":1,\"type\":\"ping\",\"client_time\":\"2026-11-19T10:00:00Z\"}");
        assertThat(aliceWs.awaitType("pong", TIMEOUT).get("type").asText()).isEqualTo("pong");
        assertThat(bobWs.awaitEventWithin("call.signal", Duration.ofMillis(400))).isNull();
        aliceWs.close();
        bobWs.close();
    }

    @Test
    void callSignalRateLimitIsPerSessionAndRecoverable() throws Exception {
        SessionResponse alice = devSession();
        SessionResponse bob = devSession();
        Room room = directRoom(alice, bob);

        WebSocketClient aliceWs = connectAndSubscribe(alice, room.chatId());
        WebSocketClient bobWs = connectAndSubscribe(room.bob(), room.chatId());

        UUID callId = UUID.randomUUID();
        for (int i = 0; i < 8; i++) {
            aliceWs.send(signalFrame(room.chatId(), callId, "hangup", false, null, null));
        }
        for (int i = 0; i < 8; i++) {
            JsonNode relayed = bobWs.awaitEvent("call.signal", TIMEOUT);
            assertThat(relayed.get("payload").get("kind").asText()).isEqualTo("hangup");
        }

        aliceWs.send(signalFrame(room.chatId(), callId, "hangup", false, null, null));
        JsonNode error = aliceWs.awaitType("error", TIMEOUT);
        assertThat(error.get("code").asText()).isEqualTo("RATE_LIMITED");
        assertThat(error.get("status").asInt()).isEqualTo(429);

        // The session survives the rejection: only the offending frame is dropped.
        aliceWs.send("{\"v\":1,\"type\":\"ping\",\"client_time\":\"2026-11-19T10:00:00Z\"}");
        assertThat(aliceWs.awaitType("pong", TIMEOUT).get("type").asText()).isEqualTo("pong");
        aliceWs.close();
        bobWs.close();
    }

    private Room directRoom(SessionResponse alice, SessionResponse bob) throws Exception {
        addWorkspaceMember(alice, bob.user().id());
        SessionResponse bobInAliceWorkspace = scoped(bob, alice);
        HttpHeaders headers = authHeaders(alice);
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.add("Idempotency-Key", UUID.randomUUID().toString());
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("type", "DIRECT");
        body.put("peer_id", bob.user().id().toString());
        ResponseEntity<String> response = rest.exchange(
                url("/api/v1/workspaces/" + alice.workspace().id() + "/chats"),
                HttpMethod.POST,
                new HttpEntity<>(objectMapper.writeValueAsString(body), headers), String.class);
        assertThat(response.getStatusCode().value()).isIn(200, 201);
        UUID chatId = UUID.fromString(objectMapper.readTree(response.getBody()).get("id").asText());
        return new Room(chatId, bobInAliceWorkspace);
    }

    private void addWorkspaceMember(SessionResponse owner, UUID userId) {
        migrator().update("""
                INSERT INTO workspace.memberships (workspace_id, user_id, role, status)
                VALUES (?, ?, 'MEMBER', 'ACTIVE')
                ON CONFLICT (workspace_id, user_id)
                DO UPDATE SET status = 'ACTIVE'
                """, owner.workspace().id(), userId);
    }

    private SessionResponse scoped(SessionResponse user, SessionResponse resource) {
        IssuedToken token = tokenIssuer.issue(user.user().id(), user.device().id(),
                resource.workspace().id());
        return new SessionResponse(token.accessToken(), token.expiresAt(), user.user(),
                user.device(), resource.workspace(), resource.chat());
    }

    private WebSocketClient connectAndSubscribe(SessionResponse session, UUID chatId)
            throws Exception {
        WebSocketClient client = connect(ticket(session).get("ticket").asText());
        client.awaitType("hello", TIMEOUT);
        client.send(subscribeFrame(chatId, 0, false));
        JsonNode subscribed = client.awaitType("subscribed", TIMEOUT);
        assertThat(subscribed.get("chats").get(0).get("accepted").asBoolean()).isTrue();
        return client;
    }

    private String subscribeFrame(UUID chatId, long lastSeq, boolean presence) {
        return "{\"v\":1,\"type\":\"subscribe\",\"chats\":[{\"chat_id\":\""
                + chatId + "\",\"last_seq\":" + lastSeq + "}],\"presence\":" + presence + "}";
    }

    private String signalFrame(UUID chatId, UUID callId, String kind, boolean video,
                               String sdp, JsonNode candidate) throws Exception {
        ObjectNode frame = objectMapper.createObjectNode();
        frame.put("v", 1);
        frame.put("type", "call.signal");
        frame.put("chat_id", chatId.toString());
        ObjectNode payload = frame.putObject("payload");
        payload.put("call_id", callId.toString());
        payload.put("kind", kind);
        payload.put("video", video);
        if (sdp != null) {
            payload.put("sdp", sdp);
        }
        if (candidate != null) {
            payload.set("candidate", candidate);
        }
        return objectMapper.writeValueAsString(frame);
    }

    private WebSocketClient connect(String ticket) {
        WebSocketClient listener = new WebSocketClient(objectMapper);
        URI uri = URI.create("ws://localhost:" + port + "/ws?ticket=" + ticket);
        WebSocket socket = HttpClient.newHttpClient().newWebSocketBuilder()
                .connectTimeout(Duration.ofSeconds(5))
                .buildAsync(uri, listener).join();
        listener.attach(socket);
        return listener;
    }

    private static LogCapture attachLogCapture() {
        Logger logger = (Logger) LoggerFactory.getLogger("ru.krug.backend");
        Level previous = logger.getLevel();
        ListAppender<ILoggingEvent> appender = new ListAppender<>();
        appender.start();
        logger.addAppender(appender);
        logger.setLevel(Level.TRACE);
        return new LogCapture(logger, appender, previous);
    }

    private record LogCapture(Logger logger, ListAppender<ILoggingEvent> appender, Level previous)
            implements AutoCloseable {

        @Override
        public void close() {
            logger.detachAppender(appender);
            logger.setLevel(previous);
        }
    }

    private static List<String> capturedMessages(ListAppender<ILoggingEvent> appender) {
        List<String> messages = new ArrayList<>();
        for (ILoggingEvent event : new ArrayList<>(appender.list)) {
            messages.add(event.getFormattedMessage());
        }
        return messages;
    }

    private record Room(UUID chatId, SessionResponse bob) {
    }

    /** Minimal blocking WS client (same shape as the other realtime ITs). */
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
