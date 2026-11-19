package ru.krug.backend.plugin.api;

import java.util.UUID;

import jakarta.validation.Valid;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import ru.krug.backend.plugin.api.dto.ChatPluginStateListResponse;
import ru.krug.backend.plugin.api.dto.ChatPluginStateResponse;
import ru.krug.backend.plugin.api.dto.ChatPluginUpdateRequest;
import ru.krug.backend.plugin.api.dto.PluginListResponse;
import ru.krug.backend.plugin.api.mapper.PluginApiMapper;
import ru.krug.backend.plugin.application.usecase.ListChatPluginsService;
import ru.krug.backend.plugin.application.usecase.ListPluginsService;
import ru.krug.backend.plugin.application.usecase.UpdateChatPluginService;
import ru.krug.backend.shared.application.model.Principal;

/**
 * D1.1 built-in plugin catalog and per-chat toggles. This slice is state-only: no plugin
 * code is executed, no marketplace/install endpoint exists and no external call is made.
 */
@RestController
@RequestMapping("/api/v1")
public class PluginController {

    private final ListPluginsService listCatalog;
    private final ListChatPluginsService listChatPlugins;
    private final UpdateChatPluginService updateChatPlugin;

    public PluginController(ListPluginsService listCatalog,
                            ListChatPluginsService listChatPlugins,
                            UpdateChatPluginService updateChatPlugin) {
        this.listCatalog = listCatalog;
        this.listChatPlugins = listChatPlugins;
        this.updateChatPlugin = updateChatPlugin;
    }

    @GetMapping("/plugins")
    public PluginListResponse listPlugins() {
        return PluginApiMapper.toResponse(listCatalog.list());
    }

    @GetMapping("/chats/{chatId}/plugins")
    public ChatPluginStateListResponse listChatPlugins(@PathVariable UUID chatId,
                                                       Principal principal) {
        return PluginApiMapper.toStateResponse(listChatPlugins.list(principal, chatId));
    }

    @PatchMapping("/chats/{chatId}/plugins/{pluginId}")
    public ChatPluginStateResponse updateChatPlugin(@PathVariable UUID chatId,
                                                    @PathVariable String pluginId,
                                                    @Valid @RequestBody
                                                    ChatPluginUpdateRequest request,
                                                    Principal principal) {
        return PluginApiMapper.toResponse(updateChatPlugin.update(principal, chatId, pluginId,
                request.enabled()));
    }
}
