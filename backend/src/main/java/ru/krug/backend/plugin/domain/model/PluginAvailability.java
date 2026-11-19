package ru.krug.backend.plugin.domain.model;

/**
 * Effective availability of one plugin in one chat. {@code reason} is null exactly when
 * {@code available} is true.
 */
public record PluginAvailability(boolean available, PluginUnavailableReason reason) {

    public static PluginAvailability ok() {
        return new PluginAvailability(true, null);
    }

    public static PluginAvailability unavailable(PluginUnavailableReason reason) {
        return new PluginAvailability(false, reason);
    }
}
