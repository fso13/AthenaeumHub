package ru.krug.backend.plugin.application.usecase;

import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.audit.application.model.AuditRecord;
import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.plugin.application.model.ChatPluginStateView;
import ru.krug.backend.plugin.application.model.PluginChatContext;
import ru.krug.backend.plugin.application.port.PluginChatAccessPort;
import ru.krug.backend.plugin.domain.model.Plugin;
import ru.krug.backend.plugin.domain.model.PluginAvailability;
import ru.krug.backend.plugin.domain.model.PluginAvailabilityPolicy;
import ru.krug.backend.plugin.domain.repository.ChatPluginRepository;
import ru.krug.backend.plugin.domain.repository.PluginCatalogRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * {@code PATCH /chats/{chatId}/plugins/{pluginId}} body {@code {enabled}}.
 *
 * <p>Authorization is chat-scoped: ACTIVE chat {@code OWNER}/{@code ADMIN} only, and the
 * caller must be an ACTIVE chat member. Unknown/foreign/deleted chats are {@code 404}
 * (existence is hidden); known chats with an insufficient role are {@code 403}.</p>
 *
 * <p>The plugin must exist and be available in the chat's mode. A server-side
 * ({@code MANAGED}-only) plugin can never be enabled in an E2EE chat —
 * {@code 422 PLUGIN_NOT_AVAILABLE} — and a catalog kill switch is
 * {@code 422 PLUGIN_DISABLED}. The operation is idempotent: an unchanged value returns
 * {@code 200} without touching {@code updated_by}/{@code updated_at} and without a second
 * audit event. Audit metadata is limited to the plugin id and the boolean state.</p>
 */
@Service
public class UpdateChatPluginService {

    static final String ACTION = "chat.plugin.changed";

    private final PluginChatAccessPort access;
    private final PluginCatalogRepository catalog;
    private final ChatPluginRepository chatPlugins;
    private final AuditPort audit;
    private final ClockPort clock;

    public UpdateChatPluginService(PluginChatAccessPort access, PluginCatalogRepository catalog,
                                   ChatPluginRepository chatPlugins, AuditPort audit,
                                   ClockPort clock) {
        this.access = access;
        this.catalog = catalog;
        this.chatPlugins = chatPlugins;
        this.audit = audit;
        this.clock = clock;
    }

    @Transactional
    public ChatPluginStateView update(Principal principal, UUID chatId, String pluginId,
                                      boolean enabled) {
        PluginChatContext context = access.requireActiveChat(principal, chatId);
        if (!context.canManage()) {
            throw DomainException.forbidden(
                    "Only an active chat OWNER or ADMIN can change plugins");
        }

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

        boolean changed = chatPlugins.setEnabled(context.workspaceId(), chatId, plugin.id(),
                enabled, principal.userId(), clock.now());
        if (changed) {
            audit.append(new AuditRecord(context.workspaceId(), principal.userId(), ACTION,
                    "chat", chatId, principal.requestId(),
                    Map.of("plugin_id", plugin.id(), "enabled", enabled), clock.now()));
        }
        return new ChatPluginStateView(plugin.id(), enabled, true, null);
    }
}
