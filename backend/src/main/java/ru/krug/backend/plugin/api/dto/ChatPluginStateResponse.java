package ru.krug.backend.plugin.api.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * One per-chat plugin state. {@code reason} is omitted when the plugin is available;
 * when present it is a stable machine code, never a localized message.
 */
public record ChatPluginStateResponse(
        String pluginId,
        boolean enabled,
        boolean available,
        @JsonInclude(JsonInclude.Include.NON_NULL) String reason) {
}
