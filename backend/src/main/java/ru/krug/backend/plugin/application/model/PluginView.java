package ru.krug.backend.plugin.application.model;

import java.util.List;

/** Catalog read model matching OpenAPI {@code Plugin}. */
public record PluginView(
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

    public PluginView {
        permissions = permissions == null ? List.of() : List.copyOf(permissions);
        modes = modes == null ? List.of() : List.copyOf(modes);
    }
}
