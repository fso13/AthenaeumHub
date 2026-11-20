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

import com.fasterxml.jackson.databind.ObjectMapper;
import com.github.tomakehurst.wiremock.WireMockServer;
import com.github.tomakehurst.wiremock.core.WireMockConfiguration;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import ru.krug.backend.plugin.application.model.EffectiveTranslationSettings;
import ru.krug.backend.plugin.application.port.TranslationUnavailableException;
import ru.krug.backend.plugin.application.usecase.TranslationSettingsService;
import ru.krug.backend.plugin.infrastructure.config.TranslationProperties;
import ru.krug.backend.plugin.infrastructure.translation.HttpTranslationProvider;

/** Bounded HTTP adapter: success, failures, size cap and the no-provider default. */
class HttpTranslationProviderTest {

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
    void callsConfiguredProviderWithBoundedJsonContract() {
        server.stubFor(post(urlEqualTo("/translate"))
                .withRequestBody(equalToJson("{\"text\":\"Hello\",\"target\":\"ru\"}"))
                .willReturn(aResponse().withStatus(200)
                        .withHeader("Content-Type", "application/json")
                        .withBody("{\"text\":\"Привет\"}")));

        HttpTranslationProvider provider = provider(server.baseUrl() + "/translate", 65536);

        assertThat(provider.translate("Hello", "ru")).isEqualTo("Привет");
        server.verify(postRequestedFor(urlEqualTo("/translate")));
    }

    @Test
    void providerErrorsAndInvalidResponsesBecomeUnavailable() {
        server.stubFor(post(urlEqualTo("/bad-status"))
                .willReturn(aResponse().withStatus(500).withBody("boom")));
        server.stubFor(post(urlEqualTo("/bad-json"))
                .willReturn(aResponse().withStatus(200).withBody("not-json")));
        server.stubFor(post(urlEqualTo("/no-text"))
                .willReturn(aResponse().withStatus(200).withBody("{\"value\":\"x\"}")));

        assertUnavailable(() -> provider(server.baseUrl() + "/bad-status", 65536)
                .translate("Hello", "ru"));
        assertUnavailable(() -> provider(server.baseUrl() + "/bad-json", 65536)
                .translate("Hello", "ru"));
        assertUnavailable(() -> provider(server.baseUrl() + "/no-text", 65536)
                .translate("Hello", "ru"));
    }

    @Test
    void oversizedProviderResponseIsRejected() {
        server.stubFor(post(urlEqualTo("/huge"))
                .willReturn(aResponse().withStatus(200)
                        .withBody("{\"text\":\"" + "x".repeat(2000) + "\"}")));

        assertUnavailable(() -> provider(server.baseUrl() + "/huge", 1024)
                .translate("Hello", "ru"));
    }

    @Test
    void emptyUrlMakesNoNetworkCall() {
        HttpTranslationProvider provider = provider("", 65536);

        assertUnavailable(() -> provider.translate("Hello", "ru"));
        assertThat(server.getAllServeEvents()).isEmpty();
    }

    private HttpTranslationProvider provider(String url, int maxResponseBytes) {
        TranslationSettingsService settings = mock(TranslationSettingsService.class);
        when(settings.current()).thenReturn(url == null || url.isBlank()
                ? EffectiveTranslationSettings.disabled()
                : new EffectiveTranslationSettings(true, url));
        return new HttpTranslationProvider(settings,
                new TranslationProperties(url, Duration.ofSeconds(1), Duration.ofSeconds(1),
                        maxResponseBytes),
                new ObjectMapper());
    }

    private static void assertUnavailable(Runnable action) {
        assertThatThrownBy(action::run).isInstanceOf(TranslationUnavailableException.class);
    }
}
