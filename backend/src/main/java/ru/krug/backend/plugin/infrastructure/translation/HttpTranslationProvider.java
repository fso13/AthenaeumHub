package ru.krug.backend.plugin.infrastructure.translation;

import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.http.MediaType;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;

import ru.krug.backend.plugin.application.port.TranslationProviderPort;
import ru.krug.backend.plugin.application.port.TranslationUnavailableException;
import ru.krug.backend.plugin.infrastructure.config.TranslationProperties;

/**
 * Bounded HTTP adapter for an explicitly configured {@code krug.plugins.translate.url}.
 *
 * <p>Contract of the configured provider: {@code POST {url}} with
 * {@code {"text":"...","target":"ru"}} and a {@code 200} JSON answer {@code {"text":"..."}}.
 * The source text, URL and provider body are never logged. Connect/read timeouts and a
 * response-size cap bound the call; any deviation is an unavailable translation, never a
 * fabricated success. With an empty URL the adapter fails immediately and makes no call.</p>
 */
@Component
public class HttpTranslationProvider implements TranslationProviderPort {

    private final TranslationProperties properties;
    private final ObjectMapper objectMapper;
    private final RestClient restClient;

    public HttpTranslationProvider(TranslationProperties properties, ObjectMapper objectMapper) {
        this.properties = properties;
        this.objectMapper = objectMapper;
        SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout((int) positiveMillis(properties.connectTimeout(), 2000));
        factory.setReadTimeout((int) positiveMillis(properties.requestTimeout(), 5000));
        this.restClient = RestClient.builder().requestFactory(factory).build();
    }

    @Override
    public String translate(String text, String targetLanguage) {
        String url = properties.url();
        if (url.isEmpty() || !(url.startsWith("http://") || url.startsWith("https://"))) {
            throw new TranslationUnavailableException();
        }
        Map<String, String> payload = new LinkedHashMap<>();
        payload.put("text", text);
        payload.put("target", targetLanguage);
        try {
            return restClient.post()
                    .uri(url)
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(payload)
                    .exchange((request, response) -> {
                        if (response.getStatusCode().value() != 200) {
                            throw new TranslationUnavailableException();
                        }
                        int max = Math.max(1024, properties.maxResponseBytes());
                        byte[] body = response.getBody().readNBytes(max + 1);
                        if (body.length > max) {
                            throw new TranslationUnavailableException();
                        }
                        JsonNode root = objectMapper.readTree(body);
                        JsonNode translated = root == null ? null : root.get("text");
                        if (translated == null || !translated.isTextual()) {
                            throw new TranslationUnavailableException();
                        }
                        return translated.asText();
                    });
        } catch (TranslationUnavailableException ex) {
            throw ex;
        } catch (RestClientException ex) {
            // Deliberately no message/body/URL in the surfaced exception or logs.
            throw new TranslationUnavailableException();
        }
    }

    private static long positiveMillis(Duration duration, long fallback) {
        if (duration == null || duration.isNegative() || duration.isZero()) {
            return fallback;
        }
        return Math.max(100L, Math.min(duration.toMillis(), 60_000L));
    }
}
