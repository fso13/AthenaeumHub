package ru.krug.backend.plugin.application.usecase;

import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Function;
import java.util.stream.Collectors;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.plugin.application.model.ChatPluginStateView;
import ru.krug.backend.plugin.application.model.PluginChatContext;
import ru.krug.backend.plugin.application.port.PluginChatAccessPort;
import ru.krug.backend.plugin.domain.model.ChatPlugin;
import ru.krug.backend.plugin.domain.model.Plugin;
import ru.krug.backend.plugin.domain.model.PluginAvailability;
import ru.krug.backend.plugin.domain.model.PluginAvailabilityPolicy;
import ru.krug.backend.plugin.domain.repository.ChatPluginRepository;
import ru.krug.backend.plugin.domain.repository.PluginCatalogRepository;
import ru.krug.backend.shared.application.model.Principal;

/**
 * {@code GET /chats/{chatId}/plugins}: state of every built-in plugin for one chat.
 * Any ACTIVE chat member may read it; the state is metadata only and never includes
 * message content or keys.
 *
 * <p>A plugin with no row is {@code enabled=false}; {@code available} is derived from the
 * chat's immutable security mode and the catalog state. An E2EE chat therefore reports
 * every server-side built-in as unavailable with {@code PLUGIN_NOT_AVAILABLE}.</p>
 */
@Service
public class ListChatPluginsService {

    private final PluginChatAccessPort access;
    private final PluginCatalogRepository catalog;
    private final ChatPluginRepository chatPlugins;

    public ListChatPluginsService(PluginChatAccessPort access, PluginCatalogRepository catalog,
                                  ChatPluginRepository chatPlugins) {
        this.access = access;
        this.catalog = catalog;
        this.chatPlugins = chatPlugins;
    }

    @Transactional(readOnly = true)
    public List<ChatPluginStateView> list(Principal principal, UUID chatId) {
        PluginChatContext context = access.requireActiveChat(principal, chatId);
        Map<String, ChatPlugin> stored = chatPlugins
                .findByChat(context.workspaceId(), chatId)
                .stream()
                .collect(Collectors.toMap(ChatPlugin::pluginId, Function.identity()));
        return catalog.findAll().stream()
                .map(plugin -> toView(plugin, context, stored.get(plugin.id())))
                .toList();
    }

    static ChatPluginStateView toView(Plugin plugin, PluginChatContext context,
                                      ChatPlugin stored) {
        PluginAvailability availability = PluginAvailabilityPolicy.evaluate(plugin, context.mode());
        return new ChatPluginStateView(
                plugin.id(),
                stored != null && stored.enabled(),
                availability.available(),
                availability.reason() == null ? null : availability.reason().name());
    }
}
