package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.stream.Stream;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;
import org.junit.jupiter.params.provider.ValueSource;

import ru.krug.backend.plugin.application.service.TranslationProviderUrl;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/** Translation provider URL policy: https only, optional path, no credentials/query/secrets. */
class TranslationProviderUrlTest {

    @Test
    void acceptsPlainHttpOnlyForAnInternalHost() {
        assertThat(TranslationProviderUrl.normalize("http://libretranslate:5000/translate"))
                .isEqualTo("http://libretranslate:5000/translate");
        assertThat(TranslationProviderUrl.normalize("http://localhost:5000"))
                .isEqualTo("http://localhost:5000");
        assertThat(TranslationProviderUrl.normalize("http://127.0.0.1:5000/translate"))
                .isEqualTo("http://127.0.0.1:5000/translate");
        assertThat(TranslationProviderUrl.normalize("http://10.0.0.5:5000/translate"))
                .isEqualTo("http://10.0.0.5:5000/translate");
        assertThat(TranslationProviderUrl.normalize("http://192.168.1.20:5000"))
                .isEqualTo("http://192.168.1.20:5000");
        assertThat(TranslationProviderUrl.normalize("http://translate.internal/translate"))
                .isEqualTo("http://translate.internal/translate");
        assertThat(TranslationProviderUrl.normalize("http://[::1]:5000/translate"))
                .isEqualTo("http://[::1]:5000/translate");
        assertThat(TranslationProviderUrl.normalize("http://[fd00::1]:5000/translate"))
                .isEqualTo("http://[fd00::1]:5000/translate");
    }

    @Test
    void rejectsPlainHttpForAPublicHost() {
        for (String value : java.util.List.of(
                "http://translate.example.test/v1",
                "http://8.8.8.8:5000/translate",
                "http://[2001:db8::1]:5000/translate",
                "http://172.32.0.1:5000/translate")) {
            assertThatThrownBy(() -> TranslationProviderUrl.normalize(value))
                    .isInstanceOf(DomainException.class)
                    .satisfies(ex -> assertThat(((DomainException) ex).code())
                            .isEqualTo(ErrorCode.TRANSLATION_URL_INVALID));
        }
    }

    @Test
    void acceptsHttpsWithAndWithoutPath() {
        assertThat(TranslationProviderUrl.normalize(" https://translate.example.test/v1/translate "))
                .isEqualTo("https://translate.example.test/v1/translate");
        assertThat(TranslationProviderUrl.normalize("https://translate.example.test"))
                .isEqualTo("https://translate.example.test");
        assertThat(TranslationProviderUrl.normalize("HTTPS://translate.example.test/v1"))
                .isEqualTo("HTTPS://translate.example.test/v1");
        assertThat(TranslationProviderUrl.normalize("https://translate.example.test:8443/v1/x"))
                .isEqualTo("https://translate.example.test:8443/v1/x");
    }

    @Test
    void blankOrNullClearsTheUrl() {
        assertThat(TranslationProviderUrl.normalize(null)).isEmpty();
        assertThat(TranslationProviderUrl.normalize("   ")).isEmpty();
        assertThat(TranslationProviderUrl.normalize("")).isEmpty();
    }

    @ParameterizedTest
    @ValueSource(strings = {
            "http://translate.example.test/v1",
            "ftp://translate.example.test/v1",
            "//translate.example.test/v1",
            "translate.example.test/v1",
            "https://",
            "https:///v1",
            "https://translate.example.test/v1?api_key=secret",
            "https://translate.example.test/v1#fragment",
            "https://user:secret@translate.example.test/v1",
            "https://translate.example.test/v1/../admin",
            "https://translate.example.test/v1 has space"
    })
    void rejectsUnsafeOrNonHttpsUrls(String value) {
        assertThatThrownBy(() -> TranslationProviderUrl.normalize(value))
                .isInstanceOf(DomainException.class)
                .satisfies(ex -> assertThat(((DomainException) ex).code())
                        .isEqualTo(ErrorCode.TRANSLATION_URL_INVALID));
    }

    @ParameterizedTest
    @MethodSource("tooLongUrls")
    void rejectsOverlongUrls(String value) {
        assertThatThrownBy(() -> TranslationProviderUrl.normalize(value))
                .isInstanceOf(DomainException.class)
                .satisfies(ex -> assertThat(((DomainException) ex).code())
                        .isEqualTo(ErrorCode.TRANSLATION_URL_INVALID));
    }

    static Stream<String> tooLongUrls() {
        return Stream.of("https://translate.example.test/" + "a".repeat(2048),
                "https://translate.example.test/" + "a".repeat(4096));
    }

    @ParameterizedTest
    @ValueSource(strings = {"https://translate.example.test/v1\nadmin",
            "https://translate.example.test/v1\tadmin"})
    void rejectsControlCharacters(String value) {
        assertThatThrownBy(() -> TranslationProviderUrl.normalize(value))
                .isInstanceOf(DomainException.class);
    }
}
