package ru.krug.backend.plugin.api.mapper;

import java.util.List;

import ru.krug.backend.plugin.api.dto.AdminPluginPackageListResponse;
import ru.krug.backend.plugin.api.dto.AdminPluginPackageResponse;
import ru.krug.backend.plugin.api.dto.ChatPluginStateListResponse;
import ru.krug.backend.plugin.api.dto.ChatPluginStateResponse;
import ru.krug.backend.plugin.api.dto.PluginListResponse;
import ru.krug.backend.plugin.api.dto.PluginResponse;
import ru.krug.backend.plugin.application.model.ChatPluginStateView;
import ru.krug.backend.plugin.application.model.PluginPackageView;
import ru.krug.backend.plugin.application.model.PluginView;

/** Application read models -> API DTOs. No domain or persistence imports. */
public final class PluginApiMapper {

    private PluginApiMapper() {
    }

    public static PluginListResponse toResponse(List<PluginView> plugins) {
        List<PluginResponse> items = plugins.stream()
                .map(PluginApiMapper::toResponse)
                .toList();
        return new PluginListResponse(items);
    }

    public static PluginResponse toResponse(PluginView plugin) {
        return new PluginResponse(plugin.id(), plugin.name(), plugin.description(),
                plugin.icon(), plugin.permissions(), plugin.modes(), plugin.state(),
                plugin.kind(), plugin.version(), plugin.author(), plugin.entryUrl());
    }

    public static ChatPluginStateListResponse toStateResponse(
            List<ChatPluginStateView> states) {
        List<ChatPluginStateResponse> items = states.stream()
                .map(PluginApiMapper::toResponse)
                .toList();
        return new ChatPluginStateListResponse(items);
    }

    public static ChatPluginStateResponse toResponse(ChatPluginStateView state) {
        return new ChatPluginStateResponse(state.pluginId(), state.enabled(),
                state.available(), state.reason());
    }

    public static AdminPluginPackageListResponse toPackageResponse(
            List<PluginPackageView> packages) {
        return new AdminPluginPackageListResponse(packages.stream()
                .map(PluginApiMapper::toResponse)
                .toList());
    }

    public static AdminPluginPackageResponse toResponse(PluginPackageView pluginPackage) {
        return new AdminPluginPackageResponse(
                pluginPackage.id(),
                pluginPackage.name(),
                pluginPackage.version(),
                pluginPackage.description(),
                pluginPackage.author(),
                pluginPackage.entry(),
                pluginPackage.permissions(),
                pluginPackage.modes(),
                pluginPackage.sizeBytes(),
                pluginPackage.fileCount(),
                pluginPackage.sha256(),
                pluginPackage.installedAt());
    }
}
