package ru.krug.backend.plugin.application.model;

/** Administrator-facing translation-provider settings. */
public record TranslationSettingsView(boolean enabled, String url) {
}
