package ru.krug.backend.plugin.api.dto;

import java.util.List;

/** {@code GET /plugins} response. */
public record PluginListResponse(List<PluginResponse> items) {
}
