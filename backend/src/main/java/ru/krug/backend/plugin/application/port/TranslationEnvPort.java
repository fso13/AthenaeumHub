package ru.krug.backend.plugin.application.port;

/**
 * Environment fallback for the translation provider ({@code KRUG_PLUGINS_TRANSLATE_URL}).
 * Used only while no explicit administrator setting exists; implementations return an
 * empty string when unset and never log the value.
 */
public interface TranslationEnvPort {

    String fallbackUrl();
}
