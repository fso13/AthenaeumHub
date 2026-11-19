package ru.krug.backend.plugin.application.port;

/**
 * Provider-neutral failure. Carries no provider body, URL or source text so it is safe to
 * surface as a 503 without leaking content or secrets.
 */
public class TranslationUnavailableException extends RuntimeException {

    public TranslationUnavailableException() {
        super("translation provider unavailable", null, false, false);
    }
}
