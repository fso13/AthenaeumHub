package ru.krug.backend.plugin.domain.model;

/**
 * Single domain rule for plugin availability. The catalog kill switch wins over the mode
 * check, so a disabled plugin is reported as {@code PLUGIN_DISABLED} even in a mode it
 * would otherwise support.
 */
public final class PluginAvailabilityPolicy {

    private PluginAvailabilityPolicy() {
    }

    public static PluginAvailability evaluate(Plugin plugin, PluginMode chatMode) {
        if (plugin.state() != PluginState.ACTIVE) {
            return PluginAvailability.unavailable(PluginUnavailableReason.PLUGIN_DISABLED);
        }
        if (!plugin.supports(chatMode)) {
            return PluginAvailability.unavailable(
                    PluginUnavailableReason.PLUGIN_NOT_AVAILABLE);
        }
        return PluginAvailability.ok();
    }
}
