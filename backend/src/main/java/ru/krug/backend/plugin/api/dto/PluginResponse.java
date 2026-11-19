package ru.krug.backend.plugin.api.dto;

import java.util.List;

/** One built-in catalog row ({@code GET /plugins}). */
public record PluginResponse(
        String id,
        String name,
        String description,
        String icon,
        List<String> permissions,
        List<String> modes,
        String state) {
}
