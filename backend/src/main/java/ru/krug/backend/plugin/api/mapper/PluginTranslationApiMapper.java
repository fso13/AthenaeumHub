package ru.krug.backend.plugin.api.mapper;

import ru.krug.backend.plugin.api.dto.TranslationProviderSettingsResponse;
import ru.krug.backend.plugin.api.dto.TranslationProviderTestResponse;
import ru.krug.backend.plugin.application.model.TranslationHealthView;
import ru.krug.backend.plugin.application.model.TranslationSettingsView;

/** Translation provider read models -> admin API DTOs. */
public final class PluginTranslationApiMapper {

    private PluginTranslationApiMapper() {
    }

    public static TranslationProviderSettingsResponse toResponse(
            TranslationSettingsView view) {
        return new TranslationProviderSettingsResponse(view.enabled(), view.url());
    }

    public static TranslationProviderTestResponse toResponse(TranslationHealthView view) {
        return new TranslationProviderTestResponse(view.status(), view.latencyMs());
    }
}
