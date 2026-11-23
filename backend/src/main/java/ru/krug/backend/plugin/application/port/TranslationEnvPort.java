package ru.krug.backend.plugin.application.port;

/**
 * Environment fallback for the translation provider ({@code KRUG_PLUGINS_TRANSLATE_URL},
 * {@code KRUG_PLUGINS_TRANSLATE_PROVIDER}). Values are never logged.
 */
public interface TranslationEnvPort {

    /** Configured fallback URL, or an empty string when the installation has none. */
    String fallbackUrl();

    /** Configured fallback protocol; {@code null}/blank means {@code auto}. */
    String fallbackProvider();
}
