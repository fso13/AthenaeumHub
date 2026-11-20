package ru.krug.backend.plugin.api.dto;

import java.util.List;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * One installed catalog row ({@code GET /plugins}). Built-in rows omit version/author/
 * entry_url; external rows carry the package metadata and an authenticated asset path.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record PluginResponse(
        String id,
        String name,
        String description,
        String icon,
        List<String> permissions,
        List<String> modes,
        String state,
        String kind,
        String version,
        String author,
        String entryUrl) {
}
