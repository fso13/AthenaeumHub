package ru.krug.backend.plugin.domain.model;

/** Installation translation-provider switch and https URL. No credential is stored. */
public record TranslationSettings(boolean enabled, String url) {

    public TranslationSettings {
        url = url == null ? "" : url.strip();
    }

    public static TranslationSettings disabled() {
        return new TranslationSettings(false, "");
    }

    public boolean hasUrl() {
        return !url.isEmpty();
    }
}
