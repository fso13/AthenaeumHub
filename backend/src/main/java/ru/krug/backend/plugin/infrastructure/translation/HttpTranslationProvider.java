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

import ru.krug.backend.plugin.application.model.EffectiveTranslationSettings;
import ru.krug.backend.plugin.application.port.TranslationProbePort;
import ru.krug.backend.plugin.application.port.TranslationProviderPort;
import ru.krug.backend.plugin.application.port.TranslationUnavailableException;
import ru.krug.backend.plugin.application.usecase.TranslationSettingsService;
import ru.krug.backend.plugin.infrastructure.config.TranslationProperties;

/**
 * Bounded HTTP adapter for the installation translation provider.
 *
 * <p>The URL is read at runtime from {@link TranslationSettingsService} (administrator
 * setting, with the legacy {@code krug.plugins.translate.url} environment fallback), so a
 * PATCH takes effect on the next call without a restart. Contract of the provider:
 * {@code POST {url}} with {@code {"text":"...","target":"ru"}} and a {@code 200} JSON answer
 * {@code {"text":"..."}}. Source text, URL and provider body are never logged. Connect/read
 * timeouts and a response-size cap bound the call; any deviation is an unavailable
 * translation, never a fabricated success.</p>
 *
 * <p>The health probe uses a constant text and discards the answer: it never returns or logs
 * translated content.</p>
 */
@Component
public class HttpTranslationProvider implements TranslationProviderPort, TranslationProbePort {

    private static final String PROBE_TEXT = "ping";
    private static final String PROBE_TARGET = "en";

    private final TranslationSettingsService settings;
    private final TranslationProperties properties;
    private final ObjectMapper objectMapper;
    private final RestClient restClient;

    public HttpTranslationProvider(TranslationSettingsService settings,
                                   TranslationProperties properties,
                                   ObjectMapper objectMapper) {
        this.settings = settings;
        this.properties = properties;
        this.objectMapper = objectMapper;
        SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout((int) positiveMillis(properties.connectTimeout(), 2000));
        factory.setReadTimeout((int) positiveMillis(properties.requestTimeout(), 5000));
        this.restClient = RestClient.builder().requestFactory(factory).build();
    }

    @Override
    public String translate(String text, String targetLanguage) {
        EffectiveTranslationSettings current = settings.current();
        if (!current.usable() || !acceptable(current.url())) {
            throw new TranslationUnavailableException();
        }
        return send(current.url(), text, targetLanguage);
    }

    @Override
    public void probe() {
        EffectiveTranslationSettings current = settings.current();
        if (!current.usable() || !acceptable(current.url())) {
            throw new TranslationUnavailableException();
        }
        // The constant probe answer is deliberately discarded.
        send(current.url(), PROBE_TEXT, PROBE_TARGET);
    }

    private String send(String url, String text, String targetLanguage) {
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

    private static boolean acceptable(String url) {
        return url != null
                && (url.regionMatches(true, 0, "http://", 0, 7)
                || url.regionMatches(true, 0, "https://", 0, 8));
    }

    private static long positiveMillis(Duration duration, long fallback) {
        if (duration == null || duration.isNegative() || duration.isZero()) {
            return fallback;
        }
        return Math.max(100L, Math.min(duration.toMillis(), 60_000L));
    }
}
