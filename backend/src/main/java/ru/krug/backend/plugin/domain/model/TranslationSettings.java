package ru.krug.backend.plugin.domain.model;

/** Installation translation-provider switch, protocol and URL. No credential is stored. */
public record TranslationSettings(boolean enabled, String url, TranslationProviderKind provider) {

    public TranslationSettings {
        url = url == null ? "" : url.strip();
        provider = provider == null ? TranslationProviderKind.AUTO : provider;
    }

    public TranslationSettings(boolean enabled, String url) {
        this(enabled, url, TranslationProviderKind.AUTO);
    }

    public static TranslationSettings disabled() {
        return new TranslationSettings(false, "", TranslationProviderKind.AUTO);
    }

    public boolean hasUrl() {
        return !url.isEmpty();
    }
}
