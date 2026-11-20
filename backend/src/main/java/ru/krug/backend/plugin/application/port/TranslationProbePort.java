package ru.krug.backend.plugin.application.port;

/**
 * Provider health probe. It must make one bounded request with a constant probe text,
 * discard the provider answer and never log the URL, request or response content.
 */
public interface TranslationProbePort {

    /**
     * @throws TranslationUnavailableException when the provider is disabled, unreachable,
     *         times out or returns an unusable response
     */
    void probe();
}
