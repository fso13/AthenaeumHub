package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import ru.krug.backend.bot.application.port.BotEventTransport;
import ru.krug.backend.bot.infrastructure.config.BotEventsProperties;
import ru.krug.backend.bot.infrastructure.net.JdkBotEventTransport;

/** Bounded, redirect-free outbound behaviour of the real JDK transport. */
class JdkBotEventTransportTest {

    private HttpServer server;
    private JdkBotEventTransport transport;
    private final AtomicInteger targetCalls = new AtomicInteger();

    @BeforeEach
    void start() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/ok", exchange -> {
            exchange.sendResponseHeaders(204, -1);
            exchange.close();
        });
        server.createContext("/redirect", exchange -> {
            exchange.getResponseHeaders().add("Location", "/target");
            exchange.sendResponseHeaders(302, -1);
            exchange.close();
        });
        server.createContext("/target", exchange -> {
            targetCalls.incrementAndGet();
            exchange.sendResponseHeaders(204, -1);
            exchange.close();
        });
        server.createContext("/error", exchange -> {
            exchange.sendResponseHeaders(500, -1);
            exchange.close();
        });
        server.createContext("/slow", exchange -> {
            try {
                Thread.sleep(800);
            } catch (InterruptedException ex) {
                Thread.currentThread().interrupt();
            }
            exchange.sendResponseHeaders(204, -1);
            exchange.close();
        });
        server.start();
        transport = new JdkBotEventTransport(properties(Duration.ofSeconds(5)));
    }

    @AfterEach
    void stop() {
        server.stop(0);
    }

    @Test
    void delivers2xxAndIgnoresTheResponseBody() {
        BotEventTransport.BotEventTransportResult result = send("/ok");

        assertThat(result.success()).isTrue();
        assertThat(result.statusCode()).isEqualTo(204);
        assertThat(targetCalls.get()).isZero();
    }

    @Test
    void redirectIsNotFollowed() {
        BotEventTransport.BotEventTransportResult result = send("/redirect");

        assertThat(result.success()).isFalse();
        assertThat(result.statusCode()).isEqualTo(302);
        assertThat(result.error()).isEqualTo("redirect_not_allowed");
        assertThat(result.retryable()).isFalse();
        assertThat(targetCalls.get()).isZero();
    }

    @Test
    void serverErrorIsRetryableButClientErrorIsNot() {
        BotEventTransport.BotEventTransportResult error = send("/error");
        assertThat(error.success()).isFalse();
        assertThat(error.statusCode()).isEqualTo(500);
        assertThat(error.retryable()).isTrue();

        JdkBotEventTransport shortTimeout = new JdkBotEventTransport(
                properties(Duration.ofMillis(100)));
        URI uri = URI.create(base() + "/slow");
        BotEventTransport.BotEventTransportResult timeout = shortTimeout.send(uri,
                Map.of("Content-Type", "application/json"), new byte[] {1, 2, 3});
        assertThat(timeout.success()).isFalse();
        assertThat(timeout.error()).isEqualTo("timeout");
        assertThat(timeout.retryable()).isTrue();
    }

    private BotEventTransport.BotEventTransportResult send(String path) {
        return transport.send(URI.create(base() + path),
                Map.of("Content-Type", "application/json"), "{}".getBytes());
    }

    private String base() {
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    private static BotEventsProperties properties(Duration requestTimeout) {
        return new BotEventsProperties("http://localhost/api/v1", Duration.ofSeconds(1),
                requestTimeout, 65536, 6, Duration.ofSeconds(1), Duration.ofHours(1),
                false, Duration.ofSeconds(1), 25, Duration.ofMinutes(5));
    }
}
