package ru.krug.backend.plugin.api.dto;

/**
 * Response DTO for {@code POST /admin/plugins/translate/test}. Only status and measured
 * latency are exposed; no provider content or URL is echoed.
 */
public record TranslationProviderTestResponse(String status, long latencyMs) {
}
