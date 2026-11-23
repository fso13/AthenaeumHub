package ru.krug.backend.plugin.infrastructure.translation;

import java.io.IOException;
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
import ru.krug.backend.plugin.application.service.TranslationEndpoint;
import ru.krug.backend.plugin.application.service.TranslationProviderUrl;
import ru.krug.backend.plugin.application.usecase.TranslationSettingsService;
import ru.krug.backend.plugin.domain.model.TranslationProviderKind;
import ru.krug.backend.plugin.infrastructure.config.TranslationProperties;

/**
 * Bounded HTTP adapter for the installation translation provider (#84/#104).
 *
 * <p>The URL and protocol are read at runtime from {@link TranslationSettingsService}
 * (administrator setting, with the legacy {@code krug.plugins.translate.*} environment
 * fallback), so a PATCH takes effect on the next call without a restart. Two wire contracts
 * are supported:</p>
 *
 * <ul>
 *   <li><b>LibreTranslate</b> (self-hosted only): {@code POST {url}} with
 *       {@code {"q":"...","source":"auto","target":"ru","format":"text"}} and a {@code 200}
 *       JSON answer {@code {"translatedText":"..."}}. A bare base URL is normalised to
 *       {@code /translate}.</li>
 *   <li><b>Custom</b> (historical): {@code POST {url}} with
 *       {@code {"text":"...","target":"ru"}} and {@code {"text":"..."}} back.</li>
 * </ul>
 *
 * <p>{@code AUTO} detects LibreTranslate by the {@code /translate} path. If such an
 * auto-detected call is rejected by the endpoint (HTTP error or an answer without
 * {@code translatedText}), the adapter retries the custom shape exactly once, so a legacy
 * custom provider that happens to live at {@code /translate} keeps working. Explicit
 * {@code CUSTOM}/{@code LIBRETRANSLATE} never retries.</p>
 *
 * <p>Source text, URL and provider body are never logged. Connect/read timeouts and a
 * response-size cap bound every call; any deviation is an unavailable translation, never a
 * fabricated success. The health probe uses a constant text and discards the answer: it
 * never returns or logs translated content.</p>
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
        if (!current.usable() || !TranslationProviderUrl.isSupported(current.url())) {
            throw new TranslationUnavailableException();
        }
        TranslationEndpoint endpoint = TranslationEndpoint.resolve(current.url(),
                current.provider());
        boolean autoDetected = current.provider() == TranslationProviderKind.AUTO;
        return dispatch(endpoint, autoDetected, text, targetLanguage);
    }

    @Override
    public void probe() {
        EffectiveTranslationSettings current = settings.current();
        if (!current.usable() || !TranslationProviderUrl.isSupported(current.url())) {
            throw new TranslationUnavailableException();
        }
        TranslationEndpoint endpoint = TranslationEndpoint.resolve(current.url(),
                current.provider());
        boolean autoDetected = current.provider() == TranslationProviderKind.AUTO;
        // The constant probe answer is deliberately discarded.
        dispatch(endpoint, autoDetected, PROBE_TEXT, PROBE_TARGET);
    }

    private String dispatch(TranslationEndpoint endpoint, boolean autoDetected, String text,
                            String targetLanguage) {
        try {
            if (endpoint.kind() == TranslationProviderKind.LIBRETRANSLATE) {
                return sendLibreTranslate(endpoint.url(), text, targetLanguage);
            }
            return sendCustom(endpoint.url(), text, targetLanguage);
        } catch (ProtocolMismatchException ex) {
            if (autoDetected && endpoint.kind() == TranslationProviderKind.LIBRETRANSLATE) {
                // One bounded compatibility retry: the endpoint responded, but not with the
                // LibreTranslate contract. It may be a legacy custom provider at /translate.
                try {
                    return sendCustom(endpoint.url(), text, targetLanguage);
                } catch (ProtocolMismatchException | TranslationUnavailableException retry) {
                    throw new TranslationUnavailableException();
                }
            }
            throw new TranslationUnavailableException();
        }
    }

    private String sendLibreTranslate(String url, String text, String targetLanguage) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("q", text);
        payload.put("source", "auto");
        payload.put("target", targetLanguage);
        payload.put("format", "text");
        return post(url, payload, "translatedText");
    }

    private String sendCustom(String url, String text, String targetLanguage) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("text", text);
        payload.put("target", targetLanguage);
        return post(url, payload, "text");
    }

    /**
     * One bounded POST. A non-200 answer, an oversized/malformed body or a missing/blank
     * text field is a {@link ProtocolMismatchException} (the endpoint answered); transport
     * failures are an unavailable translation directly.
     */
    private String post(String url, Map<String, Object> payload, String textField) {
        try {
            return restClient.post()
                    .uri(url)
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(payload)
                    .exchange((request, response) -> {
                        if (response.getStatusCode().value() != 200) {
                            throw new ProtocolMismatchException();
                        }
                        int max = Math.max(1024, properties.maxResponseBytes());
                        byte[] body;
                        try {
                            body = response.getBody().readNBytes(max + 1);
                        } catch (IOException ex) {
                            throw new ProtocolMismatchException();
                        }
                        if (body.length > max) {
                            throw new ProtocolMismatchException();
                        }
                        JsonNode root;
                        try {
                            root = objectMapper.readTree(body);
                        } catch (IOException ex) {
                            throw new ProtocolMismatchException();
                        }
                        JsonNode translated = root == null ? null : root.get(textField);
                        if (translated == null || !translated.isTextual()
                                || translated.asText().isBlank()) {
                            throw new ProtocolMismatchException();
                        }
                        return translated.asText();
                    });
        } catch (ProtocolMismatchException ex) {
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

    /** Internal signal: the endpoint answered, but not with the requested contract. */
    private static final class ProtocolMismatchException extends RuntimeException {
        private ProtocolMismatchException() {
            super(null, null, false, false);
        }
    }
}
