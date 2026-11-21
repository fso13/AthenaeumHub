package ru.krug.backend.plugin.application.model;

/**
 * State of the built-in music-room plugin. {@code version} is the slice version 1.0.0
 * exposed by the API because built-in catalog rows carry no package version; {@code reason}
 * is a stable machine code only when the plugin is unavailable (never a localized message).
 */
public record MusicRoomPluginStateView(
        String pluginId,
        boolean enabled,
        boolean available,
        String version,
        String reason) {
}
