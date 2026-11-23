package ru.krug.backend.unit;

import static com.github.tomakehurst.wiremock.client.WireMock.aResponse;
import static com.github.tomakehurst.wiremock.client.WireMock.equalToJson;
import static com.github.tomakehurst.wiremock.client.WireMock.post;
import static com.github.tomakehurst.wiremock.client.WireMock.postRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.urlEqualTo;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import java.time.Duration;
import java.util.List;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.github.tomakehurst.wiremock.WireMockServer;
import com.github.tomakehurst.wiremock.core.WireMockConfiguration;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;

import ru.krug.backend.plugin.application.model.EffectiveTranslationSettings;
import ru.krug.backend.plugin.application.port.TranslationUnavailableException;
import ru.krug.backend.plugin.application.usecase.TranslationSettingsService;
import ru.krug.backend.plugin.domain.model.TranslationProviderKind;
import ru.krug.backend.plugin.infrastructure.config.TranslationProperties;
import ru.krug.backend.plugin.infrastructure.translation.HttpTranslationProvider;

/**
 * #104 bounded HTTP adapter: LibreTranslate payload/parse, legacy custom contract, auto
 * detection with one compatibility retry, failures, size cap, no-provider default and the
 * no-content/no-URL logging guarantee.
 */
class HttpTranslationProviderTest {

    private static final String LT_BODY =
            "{\"q\":\"Hello\",\"source\":\"auto\",\"target\":\"ru\",\"format\":\"text\"}";
    private static final String CUSTOM_BODY = "{\"text\":\"Hello\",\"target\":\"ru\"}";

    private WireMockServer server;

    @BeforeEach
    void start() {
        server = new WireMockServer(WireMockConfiguration.options().dynamicPort());
        server.start();
    }

    @AfterEach
    void stop() {
        server.stop();
    }

    @Test
    void libreTranslatePayloadIsSentAndTranslatedTextIsParsed() {
        server.stubFor(post(urlEqualTo("/translate"))
                .withRequestBody(equalToJson(LT_BODY))
                .willReturn(json(200, "{\"translatedText\":\"Привет\","
                        + "\"detectedLanguage\":{\"language\":\"en\",\"confidence\":90}}")));

        HttpTranslationProvider provider = provider(server.baseUrl() + "/translate", 65536,
                TranslationProviderKind.AUTO);

        assertThat(provider.translate("Hello", "ru")).isEqualTo("Привет");
        server.verify(1, postRequestedFor(urlEqualTo("/translate")));
    }

    @Test
    void nonTranslatePathKeepsTheLegacyCustomContract() {
        server.stubFor(post(urlEqualTo("/v1/legacy"))
                .withRequestBody(equalToJson(CUSTOM_BODY))
                .willReturn(json(200, "{\"text\":\"Привет\"}")));

        HttpTranslationProvider provider = provider(server.baseUrl() + "/v1/legacy", 65536,
                TranslationProviderKind.AUTO);

        assertThat(provider.translate("Hello", "ru")).isEqualTo("Привет");
        server.verify(1, postRequestedFor(urlEqualTo("/v1/legacy")));
    }

    @Test
    void autoDetectedCustomProviderAtTranslatePathFallsBackOnce() {
        // A legacy deployment that stores its {text,target} provider at /translate: the
        // LibreTranslate attempt is answered with 404, then the adapter retries the old
        // shape exactly once and succeeds.
        server.stubFor(post(urlEqualTo("/translate"))
                .withRequestBody(equalToJson(CUSTOM_BODY))
                .willReturn(json(200, "{\"text\":\"Привет\"}")));

        HttpTranslationProvider provider = provider(server.baseUrl() + "/translate", 65536,
                TranslationProviderKind.AUTO);

        assertThat(provider.translate("Hello", "ru")).isEqualTo("Привет");
        server.verify(2, postRequestedFor(urlEqualTo("/translate")));
    }

    @Test
    void explicitCustomProviderAtTranslatePathNeverRetries() {
        server.stubFor(post(urlEqualTo("/translate"))
                .withRequestBody(equalToJson(CUSTOM_BODY))
                .willReturn(json(200, "{\"text\":\"Привет\"}")));

        HttpTranslationProvider provider = provider(server.baseUrl() + "/translate", 65536,
                TranslationProviderKind.CUSTOM);

        assertThat(provider.translate("Hello", "ru")).isEqualTo("Привет");
        server.verify(1, postRequestedFor(urlEqualTo("/translate")));
    }

    @Test
    void explicitLibreTranslateOnABaseUrlAppendsTheEndpoint() {
        server.stubFor(post(urlEqualTo("/translate"))
                .withRequestBody(equalToJson(LT_BODY))
                .willReturn(json(200, "{\"translatedText\":\"Привет\"}")));

        HttpTranslationProvider provider = provider(server.baseUrl(), 65536,
                TranslationProviderKind.LIBRETRANSLATE);

        assertThat(provider.translate("Hello", "ru")).isEqualTo("Привет");
        server.verify(1, postRequestedFor(urlEqualTo("/translate")));
    }

    @Test
    void libreTranslateErrorsAndInvalidAnswersBecomeUnavailable() {
        server.stubFor(post(urlEqualTo("/lt-500"))
                .willReturn(json(500, "{\"error\":\"internal\"}")));
        server.stubFor(post(urlEqualTo("/lt-error"))
                .willReturn(json(200, "{\"error\":\"language not supported\"}")));
        server.stubFor(post(urlEqualTo("/lt-shape"))
                .willReturn(json(200, "{\"translatedText\":42}")));
        server.stubFor(post(urlEqualTo("/lt-blank"))
                .willReturn(json(200, "{\"translatedText\":\"   \"}")));
        server.stubFor(post(urlEqualTo("/lt-not-json"))
                .willReturn(aResponse().withStatus(200).withBody("not-json")));

        for (String path : List.of("/lt-500", "/lt-error", "/lt-shape", "/lt-blank",
                "/lt-not-json")) {
            assertUnavailable(() -> provider(server.baseUrl() + path, 65536,
                    TranslationProviderKind.LIBRETRANSLATE).translate("Hello", "ru"));
        }
    }

    @Test
    void oversizedLibreTranslateResponseIsRejected() {
        server.stubFor(post(urlEqualTo("/huge"))
                .willReturn(json(200,
                        "{\"translatedText\":\"" + "x".repeat(2000) + "\"}")));

        assertUnavailable(() -> provider(server.baseUrl() + "/huge", 1024,
                TranslationProviderKind.AUTO).translate("Hello", "ru"));
    }

    @Test
    void emptyUrlMakesNoNetworkCall() {
        HttpTranslationProvider provider = provider("", 65536, TranslationProviderKind.AUTO);

        assertUnavailable(() -> provider.translate("Hello", "ru"));
        assertThat(server.getAllServeEvents()).isEmpty();
    }

    @Test
    void probeUsesAConstantTextAndDiscardsTheAnswer() {
        server.stubFor(post(urlEqualTo("/translate"))
                .withRequestBody(equalToJson("{\"q\":\"ping\",\"source\":\"auto\","
                        + "\"target\":\"en\",\"format\":\"text\"}"))
                .willReturn(json(200, "{\"translatedText\":\"provider-answer\"}")));

        HttpTranslationProvider provider = provider(server.baseUrl() + "/translate", 65536,
                TranslationProviderKind.LIBRETRANSLATE);

        provider.probe();
        server.verify(1, postRequestedFor(urlEqualTo("/translate")));
    }

    @Test
    void sourceTextUrlAndProviderBodyAreNeverLogged() {
        server.stubFor(post(urlEqualTo("/secret-path"))
                .willReturn(aResponse().withStatus(500)
                        .withBody("provider-secret-body for secret source text")));
        Logger root = (Logger) LoggerFactory.getLogger(Logger.ROOT_LOGGER_NAME);
        ListAppender<ILoggingEvent> appender = new ListAppender<>();
        appender.start();
        root.addAppender(appender);
        try {
            HttpTranslationProvider provider = provider(server.baseUrl() + "/secret-path",
                    65536, TranslationProviderKind.CUSTOM);
            assertUnavailable(() -> provider.translate("secret source text", "ru"));
        } finally {
            root.detachAppender(appender);
        }

        assertThat(appender.list)
                .noneMatch(event -> String.valueOf(event.getFormattedMessage())
                        .contains("secret source text"))
                .noneMatch(event -> String.valueOf(event.getFormattedMessage())
                        .contains("provider-secret-body"))
                .noneMatch(event -> String.valueOf(event.getFormattedMessage())
                        .contains("secret-path"));
    }

    private HttpTranslationProvider provider(String url, int maxResponseBytes,
                                             TranslationProviderKind kind) {
        TranslationSettingsService settings = mock(TranslationSettingsService.class);
        when(settings.current()).thenReturn(url == null || url.isBlank()
                ? EffectiveTranslationSettings.disabled()
                : new EffectiveTranslationSettings(true, url, kind));
        return new HttpTranslationProvider(settings,
                new TranslationProperties(url, Duration.ofSeconds(1), Duration.ofSeconds(1),
                        maxResponseBytes),
                new ObjectMapper());
    }

    private static com.github.tomakehurst.wiremock.client.ResponseDefinitionBuilder json(
            int status, String body) {
        return aResponse().withStatus(status)
                .withHeader("Content-Type", "application/json")
                .withBody(body);
    }

    private static void assertUnavailable(Runnable action) {
        assertThatThrownBy(action::run).isInstanceOf(TranslationUnavailableException.class);
    }
}
