package ru.krug.backend.plugin.api.dto;

import java.util.List;

/** {@code GET /admin/plugins} response. */
public record AdminPluginPackageListResponse(List<AdminPluginPackageResponse> items) {
}
