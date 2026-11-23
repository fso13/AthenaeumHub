package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

import ru.krug.backend.plugin.application.service.TranslationEndpoint;
import ru.krug.backend.plugin.domain.model.TranslationProviderKind;

/** #104 protocol detection: /translate means LibreTranslate, explicit kinds override it. */
class TranslationEndpointTest {

    @ParameterizedTest
    @CsvSource({
            "https://translate.example.test/translate, true",
            "https://translate.example.test/v1/translate, true",
            "https://translate.example.test/translate/, true",
            "HTTPS://translate.example.test/TRANSLATE, true",
            "http://libretranslate:5000/translate, true",
            "https://translate.example.test, false",
            "https://translate.example.test/v1, false",
            "https://translate.example.test/translate2, false",
            "https://translate.example.test/v1/translate/status, false"
    })
    void detectsTheLibreTranslatePath(String url, boolean expected) {
        assertThat(TranslationEndpoint.isLibreTranslatePath(url)).isEqualTo(expected);
    }

    @Test
    void autoUsesLibreTranslateForATranslatePath() {
        TranslationEndpoint endpoint = TranslationEndpoint.resolve(
                "https://translate.example.test/v1/translate",
                TranslationProviderKind.AUTO);

        assertThat(endpoint.kind()).isEqualTo(TranslationProviderKind.LIBRETRANSLATE);
        assertThat(endpoint.url()).isEqualTo("https://translate.example.test/v1/translate");
    }

    @Test
    void autoKeepsTheLegacyContractForAnyOtherPath() {
        TranslationEndpoint endpoint = TranslationEndpoint.resolve(
                "https://translate.example.test/v1/legacy", TranslationProviderKind.AUTO);

        assertThat(endpoint.kind()).isEqualTo(TranslationProviderKind.CUSTOM);
        assertThat(endpoint.url()).isEqualTo("https://translate.example.test/v1/legacy");
    }

    @Test
    void explicitCustomWinsOverThePathHeuristic() {
        TranslationEndpoint endpoint = TranslationEndpoint.resolve(
                "https://translate.example.test/translate", TranslationProviderKind.CUSTOM);

        assertThat(endpoint.kind()).isEqualTo(TranslationProviderKind.CUSTOM);
        assertThat(endpoint.url()).isEqualTo("https://translate.example.test/translate");
    }

    @Test
    void explicitLibreTranslateAppendsTheEndpointToABaseUrl() {
        assertThat(TranslationEndpoint.resolve("http://libretranslate:5000",
                TranslationProviderKind.LIBRETRANSLATE).url())
                .isEqualTo("http://libretranslate:5000/translate");
        assertThat(TranslationEndpoint.resolve("http://libretranslate:5000/",
                TranslationProviderKind.LIBRETRANSLATE).url())
                .isEqualTo("http://libretranslate:5000/translate");
    }

    @Test
    void explicitLibreTranslateNormalisesATrailingSlash() {
        assertThat(TranslationEndpoint.resolve("http://libretranslate:5000/translate/",
                TranslationProviderKind.LIBRETRANSLATE).url())
                .isEqualTo("http://libretranslate:5000/translate");
    }

    @Test
    void nullProviderMeansAuto() {
        assertThat(TranslationEndpoint.resolve("https://translate.example.test/v1", null).kind())
                .isEqualTo(TranslationProviderKind.CUSTOM);
    }

    @Test
    void providerParsingIsCaseInsensitiveAndRejectsTypos() {
        assertThat(TranslationProviderKind.parse("libretranslate"))
                .contains(TranslationProviderKind.LIBRETRANSLATE);
        assertThat(TranslationProviderKind.parse("Custom"))
                .contains(TranslationProviderKind.CUSTOM);
        assertThat(TranslationProviderKind.parse("  "))
                .contains(TranslationProviderKind.AUTO);
        assertThat(TranslationProviderKind.parse("libra")).isEmpty();
        assertThat(TranslationProviderKind.fromWireOrDefault("libra"))
                .isEqualTo(TranslationProviderKind.AUTO);
    }
}
