package ru.krug.backend.bot.application.port;

import java.net.URI;
import java.util.Map;

/**
 * Outbound webhook transport. The URL has already passed the SSRF guard; the transport only
 * enforces no-redirects, bounded reads and the 5 s timeout, and never logs the URL/body.
 */
public interface BotEventTransport {

    BotEventTransportResult send(URI uri, Map<String, String> headers, byte[] body);

    /**
     * @param success   2xx received
     * @param statusCode HTTP status or 0 for a network failure
     * @param error      content-free reason such as {@code timeout}/{@code http_500}
     * @param retryable whether a later attempt may succeed
     */
    record BotEventTransportResult(boolean success, int statusCode, String error,
                                   boolean retryable) {

        public static BotEventTransportResult delivered(int statusCode) {
            return new BotEventTransportResult(true, statusCode, null, false);
        }

        public static BotEventTransportResult failed(int statusCode, String error,
                                                      boolean retryable) {
            return new BotEventTransportResult(false, statusCode, error, retryable);
        }
    }
}
