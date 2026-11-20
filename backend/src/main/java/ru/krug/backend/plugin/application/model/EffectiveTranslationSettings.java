package ru.krug.backend.plugin.application.model;

/** Effective runtime translation configuration (explicit setting or environment fallback). */
public record EffectiveTranslationSettings(boolean enabled, String url) {

    public EffectiveTranslationSettings {
        url = url == null ? "" : url.strip();
    }

    public static EffectiveTranslationSettings disabled() {
        return new EffectiveTranslationSettings(false, "");
    }

    public boolean usable() {
        return enabled && !url.isEmpty();
    }
}
