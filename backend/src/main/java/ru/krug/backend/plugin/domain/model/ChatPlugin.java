package ru.krug.backend.plugin.domain.model;

import java.util.Objects;

/**
 * Stored per-chat toggle. A missing row means {@code enabled=false}; only an explicit
 * user action creates a row.
 */
public record ChatPlugin(String pluginId, boolean enabled) {

    public ChatPlugin {
        Objects.requireNonNull(pluginId, "pluginId");
    }
}
