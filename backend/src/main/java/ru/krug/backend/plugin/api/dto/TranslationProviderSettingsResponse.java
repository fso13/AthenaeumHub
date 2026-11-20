package ru.krug.backend.plugin.api.dto;

/** Response DTO for {@code GET/PATCH /admin/plugins/translate} (#84). */
public record TranslationProviderSettingsResponse(boolean enabled, String url) {
}
