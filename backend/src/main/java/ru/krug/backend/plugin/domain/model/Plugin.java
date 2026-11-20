package ru.krug.backend.plugin.domain.model;

import java.util.List;
import java.util.Objects;

/**
 * A plugin catalog row. Built-in rows are first-party metadata; external rows describe an
 * admin-installed static package. In both cases this is catalog metadata only: no
 * manifest bytes, archive, signature or executable code is represented here.
 */
public record Plugin(
        String id,
        String name,
        String description,
        String icon,
        List<String> permissions,
        List<PluginMode> modes,
        PluginState state,
        PluginKind kind,
        String version,
        String author,
        String entry) {

    public Plugin {
        Objects.requireNonNull(id, "id");
        Objects.requireNonNull(name, "name");
        Objects.requireNonNull(description, "description");
        Objects.requireNonNull(permissions, "permissions");
        Objects.requireNonNull(modes, "modes");
        Objects.requireNonNull(state, "state");
        kind = kind == null ? PluginKind.BUILTIN : kind;
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
        if (permissions.size() > 16) {
            throw new IllegalArgumentException("Plugin declares too many permissions");
        }
        for (String permission : permissions) {
            if (permission == null || permission.isBlank() || permission.length() > 64) {
                throw new IllegalArgumentException("Plugin permission is invalid");
            }
        }
        if (kind == PluginKind.BUILTIN) {
            if (version != null || author != null || entry != null) {
                throw new IllegalArgumentException(
                        "Built-in plugin must not declare package metadata");
            }
        } else {
            if (version == null || version.isBlank() || version.length() > 32) {
                throw new IllegalArgumentException(
                        "External plugin must declare a version");
            }
            if (author == null || author.isBlank() || author.length() > 120) {
                throw new IllegalArgumentException(
                        "External plugin must declare an author");
            }
            entry = PluginPaths.requireEntry(entry);
        }
        permissions = List.copyOf(permissions);
        modes = List.copyOf(modes);
    }

    /** Backwards-compatible constructor for seeded built-in rows. */
    public Plugin(String id, String name, String description, String icon,
                  List<String> permissions, List<PluginMode> modes, PluginState state) {
        this(id, name, description, icon, permissions, modes, state,
                PluginKind.BUILTIN, null, null, null);
    }

    /** True when the plugin is allowed to run in the given chat security mode. */
    public boolean supports(PluginMode mode) {
        return modes.contains(mode);
    }

    public boolean external() {
        return kind == PluginKind.EXTERNAL;
    }
}
