package ru.krug.backend.plugin.api.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * Music-room plugin state. {@code version} is the built-in slice version 1.0.0;
 * {@code reason} is present only when the plugin is unavailable.
 */
public record MusicRoomPluginResponse(
        String pluginId,
        boolean enabled,
        boolean available,
        String version,
        @JsonInclude(JsonInclude.Include.NON_NULL) String reason) {
}
