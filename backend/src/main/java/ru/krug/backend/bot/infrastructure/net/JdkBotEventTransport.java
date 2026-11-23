package ru.krug.backend.bot.infrastructure.net;

import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.time.Duration;
import java.util.Map;

import org.springframework.stereotype.Component;

import ru.krug.backend.bot.application.port.BotEventTransport;
import ru.krug.backend.bot.infrastructure.config.BotEventsProperties;

/**
 * JDK HttpClient transport for bot webhooks.
 *
 * <p>Hard guarantees: redirects are never followed, connect/read timeouts are 5 s, the
 * response body is drained through a bounded read and discarded, and the URL/headers/body
 * are never logged. The URL has already passed {@link
 * ru.krug.backend.bot.application.service.BotWebhookUrlGuard}.</p>
 */
@Component
public class JdkBotEventTransport implements BotEventTransport {

    private static final int RESPONSE_DRAIN_BYTES = 65_536;

    private final HttpClient client;
    private final Duration requestTimeout;

    public JdkBotEventTransport(BotEventsProperties properties) {
        this.requestTimeout = properties.requestTimeout();
        this.client = HttpClient.newBuilder()
                .connectTimeout(properties.connectTimeout())
                .followRedirects(HttpClient.Redirect.NEVER)
                .build();
    }

    @Override
    public BotEventTransportResult send(URI uri, Map<String, String> headers, byte[] body) {
        HttpRequest.Builder builder = HttpRequest.newBuilder(uri)
                .timeout(requestTimeout)
                .POST(HttpRequest.BodyPublishers.ofByteArray(body));
        headers.forEach(builder::header);
        try {
            HttpResponse<InputStream> response = client.send(builder.build(),
                    HttpResponse.BodyHandlers.ofInputStream());
            int status = response.statusCode();
            drain(response.body());
            if (status >= 200 && status < 300) {
                return BotEventTransportResult.delivered(status);
            }
            if (status >= 300 && status < 400) {
                return BotEventTransportResult.failed(status, "redirect_not_allowed", false);
            }
            boolean retryable = status == 408 || status == 429 || status >= 500;
            return BotEventTransportResult.failed(status, "http_" + status, retryable);
        } catch (HttpTimeoutException ex) {
            return BotEventTransportResult.failed(0, "timeout", true);
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            return BotEventTransportResult.failed(0, "interrupted", false);
        } catch (IOException | RuntimeException ex) {
            return BotEventTransportResult.failed(0, "network_error", true);
        }
    }

    private static void drain(InputStream body) {
        if (body == null) {
            return;
        }
        try (InputStream input = body) {
            input.readNBytes(RESPONSE_DRAIN_BYTES);
        } catch (IOException ignored) {
            // The response is intentionally ignored; a failed drain cannot alter the result.
        }
    }
}
