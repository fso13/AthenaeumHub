package ru.krug.backend.plugin.domain.model;

import java.util.Locale;
import java.util.Optional;

/**
 * Wire protocol of the installation translation provider.
 *
 * <p>{@link #CUSTOM} is the historical contract: {@code POST {url}} with
 * {@code {"text":"...","target":"ru"}} and {@code {"text":"..."}} back. {@link #LIBRETRANSLATE}
 * is the self-hosted LibreTranslate API: {@code POST {url}} with
 * {@code {"q":"...","source":"auto","target":"ru","format":"text"}} and
 * {@code {"translatedText":"..."}} back.</p>
 *
 * <p>{@link #AUTO} keeps existing installations working without a migration step: a URL whose
 * path ends with {@code /translate} speaks LibreTranslate, every other URL keeps the custom
 * contract. The adapter also retries the custom shape once when an auto-detected
 * LibreTranslate call fails, so a legacy custom provider that happens to live at
 * {@code /translate} keeps working. An explicit administrator choice always wins.</p>
 */
public enum TranslationProviderKind {

    AUTO,
    CUSTOM,
    LIBRETRANSLATE;

    /** Appended to a bare LibreTranslate base URL by the adapter. */
    public static final String LIBRETRANSLATE_PATH = "/translate";

    /**
     * Lenient parsing for environment/API values. {@code null}/blank means {@link #AUTO};
     * an unknown value is rejected so a typo never silently changes the protocol.
     */
    public static Optional<TranslationProviderKind> parse(String raw) {
        if (raw == null || raw.isBlank()) {
            return Optional.of(AUTO);
        }
        return switch (raw.strip().toUpperCase(Locale.ROOT)) {
            case "AUTO" -> Optional.of(AUTO);
            case "CUSTOM", "LEGACY" -> Optional.of(CUSTOM);
            case "LIBRETRANSLATE", "LIBRE", "LT" -> Optional.of(LIBRETRANSLATE);
            default -> Optional.empty();
        };
    }

    /**
     * Lenient parsing for configuration files: an unknown environment value must not stop
     * the application from starting, so it falls back to {@link #AUTO}.
     */
    public static TranslationProviderKind fromWireOrDefault(String raw) {
        return parse(raw).orElse(AUTO);
    }

    public String wire() {
        return name();
    }
}
