package ru.krug.backend.plugin.application.usecase;

import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;

import ru.krug.backend.plugin.application.model.PluginChatContext;
import ru.krug.backend.plugin.application.port.PluginChatAccessPort;
import ru.krug.backend.plugin.domain.model.Plugin;
import ru.krug.backend.plugin.domain.model.PluginAvailability;
import ru.krug.backend.plugin.domain.model.PluginAvailabilityPolicy;
import ru.krug.backend.plugin.domain.repository.ChatPluginRepository;
import ru.krug.backend.plugin.domain.repository.PluginCatalogRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * Shared action gate for polls/tasks/translate. It reuses the #69 catalog + per-chat toggle
 * and adds the action-specific "enabled" check:
 *
 * <ol>
 *   <li>ACTIVE chat membership (unknown/foreign/removed chat is a hidden 404);</li>
 *   <li>catalog plugin exists ({@code 404 PLUGIN_NOT_FOUND});</li>
 *   <li>plugin is available in the immutable chat mode (E2EE server plugin is
 *       {@code 422 PLUGIN_NOT_AVAILABLE});</li>
 *   <li>the per-chat toggle is on, otherwise {@code 422 PLUGIN_NOT_ENABLED}.</li>
 * </ol>
 *
 * No plugin code is executed; this is a pure data/authorisation gate.
 */
@Service
public class PluginActionGate {

    private final PluginChatAccessPort access;
    private final PluginCatalogRepository catalog;
    private final ChatPluginRepository chatPlugins;

    public PluginActionGate(PluginChatAccessPort access, PluginCatalogRepository catalog,
                            ChatPluginRepository chatPlugins) {
        this.access = access;
        this.catalog = catalog;
        this.chatPlugins = chatPlugins;
    }

    public PluginChatContext requireEnabled(Principal principal, UUID chatId, String pluginId) {
        PluginChatContext context = access.requireActiveChat(principal, chatId);
        Plugin plugin = catalog.findById(pluginId)
                .orElseThrow(() -> DomainException.notFound(ErrorCode.PLUGIN_NOT_FOUND,
                        "Plugin not found", Map.of("plugin_id", pluginId)));
        PluginAvailability availability = PluginAvailabilityPolicy.evaluate(plugin, context.mode());
        if (!availability.available()) {
            String reason = availability.reason().name();
            throw DomainException.unprocessable(reason,
                    "Plugin is not available in this chat",
                    Map.of("plugin_id", pluginId, "reason", reason));
        }
        if (!chatPlugins.isEnabled(context.workspaceId(), chatId, plugin.id())) {
            throw DomainException.unprocessable(ErrorCode.PLUGIN_NOT_ENABLED,
                    "Plugin is not enabled in this chat",
                    Map.of("plugin_id", pluginId));
        }
        return context;
    }
}
