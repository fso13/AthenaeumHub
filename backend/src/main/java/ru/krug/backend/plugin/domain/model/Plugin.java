package ru.krug.backend.plugin.domain.model;

import java.util.List;
import java.util.Objects;

/**
 * A built-in first-party plugin from {@code plugin.catalog}. This is catalog metadata
 * only; no manifest, archive, signature or executable code is represented.
 */
public record Plugin(
        String id,
        String name,
        String description,
        String icon,
        List<PluginPermission> permissions,
        List<PluginMode> modes,
        PluginState state) {

    public Plugin {
        Objects.requireNonNull(id, "id");
        Objects.requireNonNull(name, "name");
        Objects.requireNonNull(description, "description");
        Objects.requireNonNull(permissions, "permissions");
        Objects.requireNonNull(modes, "modes");
        Objects.requireNonNull(state, "state");
        if (!id.matches("[a-z][a-z0-9-]{0,63}")) {
            throw new IllegalArgumentException("Plugin id must be a lowercase slug");
        }
        if (name.isBlank() || name.length() > 120) {
            throw new IllegalArgumentException("Plugin name must be 1..120 characters");
        }
        if (description.isBlank() || description.length() > 500) {
            throw new IllegalArgumentException("Plugin description must be 1..500 characters");
        }
        if (icon != null && (icon.isBlank() || icon.length() > 64)) {
            throw new IllegalArgumentException("Plugin icon must be 1..64 characters or null");
        }
        if (modes.isEmpty()) {
            throw new IllegalArgumentException("Plugin must declare at least one mode");
        }
        permissions = List.copyOf(permissions);
        modes = List.copyOf(modes);
    }

    /** True when the plugin is allowed to run in the given chat security mode. */
    public boolean supports(PluginMode mode) {
        return modes.contains(mode);
    }
}
