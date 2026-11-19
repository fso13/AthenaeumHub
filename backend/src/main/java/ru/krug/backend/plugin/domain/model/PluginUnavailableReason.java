package ru.krug.backend.plugin.domain.model;

/** Machine-readable reason why a plugin cannot be used in a chat right now. */
public enum PluginUnavailableReason {
    /** The chat security mode is not listed in the plugin's {@code modes}. */
    PLUGIN_NOT_AVAILABLE,
    /** The catalog row is disabled by a product kill switch. */
    PLUGIN_DISABLED
}
