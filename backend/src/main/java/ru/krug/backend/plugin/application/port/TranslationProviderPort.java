package ru.krug.backend.plugin.application.port;

/**
 * Outbound translation port. Implementations must be bounded (timeout/size), must not log
 * the source or translated text and must throw {@link TranslationUnavailableException}
 * instead of returning a fabricated translation. The default implementation has no
 * provider configured and therefore always throws; no external call happens by default.
 */
public interface TranslationProviderPort {

    /**
     * @throws TranslationUnavailableException when no provider is configured, the call
     *         fails/times out, or the provider returns an unusable response.
     */
    String translate(String text, String targetLanguage);
}
