package ru.krug.backend.plugin.application.service;

import java.net.URI;
import java.util.Locale;

import ru.krug.backend.plugin.domain.model.TranslationProviderKind;

/**
 * Resolved outbound endpoint: the concrete protocol plus the URL that must be called.
 *
 * <p>A LibreTranslate base URL such as {@code http://libretranslate:5000} is normalised to
 * {@code http://libretranslate:5000/translate}, so an administrator may paste either the
 * service root or the endpoint. The custom contract keeps the configured URL untouched.</p>
 */
public record TranslationEndpoint(TranslationProviderKind kind, String url) {

    public TranslationEndpoint {
        if (kind == null) {
            kind = TranslationProviderKind.AUTO;
        }
        url = url == null ? "" : url.strip();
    }

    /**
     * Resolves the configured kind and URL. In {@link TranslationProviderKind#AUTO} the path
     * decides: a last segment of {@code translate} means LibreTranslate, anything else keeps
     * the legacy custom contract.
     */
    public static TranslationEndpoint resolve(String url,
                                              TranslationProviderKind configured) {
        String value = url == null ? "" : url.strip();
        TranslationProviderKind requested = configured == null
                ? TranslationProviderKind.AUTO : configured;
        TranslationProviderKind kind = requested == TranslationProviderKind.AUTO
                ? (isLibreTranslatePath(value) ? TranslationProviderKind.LIBRETRANSLATE
                        : TranslationProviderKind.CUSTOM)
                : requested;
        if (kind == TranslationProviderKind.LIBRETRANSLATE) {
            return new TranslationEndpoint(kind, libreTranslateUrl(value));
        }
        return new TranslationEndpoint(kind, value);
    }

    /** True when the URL's last path segment is {@code translate} (case-insensitive). */
    public static boolean isLibreTranslatePath(String url) {
        String path = pathOf(url);
        if (path == null) {
            return false;
        }
        String trimmed = path.replaceAll("/+$", "");
        return trimmed.toLowerCase(Locale.ROOT).endsWith(
                TranslationProviderKind.LIBRETRANSLATE_PATH);
    }

    /**
     * Appends {@code /translate} to a LibreTranslate base URL and leaves an already complete
     * endpoint untouched.
     */
    public static String libreTranslateUrl(String url) {
        String value = url == null ? "" : url.strip();
        String base = value.replaceAll("/+$", "");
        if (isLibreTranslatePath(value)) {
            return base;
        }
        return base + TranslationProviderKind.LIBRETRANSLATE_PATH;
    }

    private static String pathOf(String url) {
        try {
            return URI.create(url).getPath();
        } catch (IllegalArgumentException ex) {
            return null;
        }
    }
}
