package ru.krug.backend.support;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.time.Duration;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.function.Predicate;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * Minimal blocking WS client shared by realtime integration tests (extracted from
 * {@code RealtimeWebSocketIT}). Collects every frame and lets a test await a type/event.
 */
public final class WsTestClient implements WebSocket.Listener {

    private final ObjectMapper mapper;
    private final BlockingQueue<JsonNode> frames = new LinkedBlockingQueue<>();
    /** Frames skipped by an earlier await; they must stay available for a later await. */
    private final java.util.List<JsonNode> pending = new java.util.ArrayList<>();
    private final StringBuilder buffer = new StringBuilder();
    private volatile WebSocket socket;
    private volatile int closeCode = -1;

    public WsTestClient(ObjectMapper mapper) {
        this.mapper = mapper;
    }

    public static WsTestClient connect(ObjectMapper mapper, int port, String ticket,
                                       String origin) {
        WsTestClient listener = new WsTestClient(mapper);
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

    public void send(String json) {
        socket.sendText(json, true).join();
    }

    public JsonNode awaitType(String type, Duration timeout) {
        return await(frame -> type.equals(frame.path("type").asText()), timeout);
    }

    public JsonNode awaitEvent(String event, Duration timeout) {
        return await(frame -> "event".equals(frame.path("type").asText())
                && event.equals(frame.path("event").asText()), timeout);
    }

    /** Non-failing variant: {@code null} when the frame does not arrive in time. */
    public JsonNode awaitEventWithin(String event, Duration timeout) {
        try {
            return awaitEvent(event, timeout);
        } catch (AssertionError ex) {
            return null;
        }
    }

    /**
     * Waits for {@code event} whose payload field {@code field} equals {@code value}; other
     * frames of the same event (for example a different device) are skipped.
     */
    public JsonNode awaitEventWhere(String event, String field, String value,
                                    Duration timeout) {
        return await(frame -> "event".equals(frame.path("type").asText())
                && event.equals(frame.path("event").asText())
                && value.equals(frame.path("payload").path(field).asText()), timeout);
    }

    public JsonNode awaitClose(Duration timeout) {
        long deadline = System.nanoTime() + timeout.toNanos();
        while (System.nanoTime() < deadline) {
            if (closeCode != -1) {
                return mapper.createObjectNode().put("close_code", closeCode);
            }
            sleep(20);
        }
        throw new AssertionError("WS connection was not closed; last close_code=" + closeCode);
    }

    public int closeCode() {
        return closeCode;
    }

    public void close() {
        WebSocket current = socket;
        if (current != null) {
            current.sendClose(WebSocket.NORMAL_CLOSURE, "test done")
                    .exceptionally(ex -> null)
                    .join();
        }
    }

    private JsonNode await(Predicate<JsonNode> predicate, Duration timeout) {
        java.util.Iterator<JsonNode> iterator = pending.iterator();
        while (iterator.hasNext()) {
            JsonNode frame = iterator.next();
            if (predicate.test(frame)) {
                iterator.remove();
                return frame;
            }
        }
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
            if (frame != null) {
                if (predicate.test(frame)) {
                    return frame;
                }
                pending.add(frame);
            }
        }
        throw new AssertionError("WS frame was not received: " + frames + " pending=" + pending
                + " close_code=" + closeCode);
    }

    private static void sleep(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            throw new AssertionError(ex);
        }
    }
}
