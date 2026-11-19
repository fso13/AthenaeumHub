package ru.krug.backend.plugin.application.model;

/**
 * Per-chat state read model matching OpenAPI {@code ChatPluginState}.
 *
 * @param reason null when {@code available=true}; otherwise a stable machine code
 *               ({@code PLUGIN_NOT_AVAILABLE} / {@code PLUGIN_DISABLED})
 */
public record ChatPluginStateView(
        String pluginId,
        boolean enabled,
        boolean available,
        String reason) {
}
