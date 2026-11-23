package ru.krug.backend.plugin.application.model;

import ru.krug.backend.plugin.domain.model.TranslationProviderKind;

/** Effective runtime translation configuration (explicit setting or environment fallback). */
public record EffectiveTranslationSettings(boolean enabled, String url,
                                           TranslationProviderKind provider) {

    public EffectiveTranslationSettings {
        url = url == null ? "" : url.strip();
        provider = provider == null ? TranslationProviderKind.AUTO : provider;
    }

    public EffectiveTranslationSettings(boolean enabled, String url) {
        this(enabled, url, TranslationProviderKind.AUTO);
    }

    public static EffectiveTranslationSettings disabled() {
        return new EffectiveTranslationSettings(false, "", TranslationProviderKind.AUTO);
    }

    public boolean usable() {
        return enabled && !url.isEmpty();
    }
}
