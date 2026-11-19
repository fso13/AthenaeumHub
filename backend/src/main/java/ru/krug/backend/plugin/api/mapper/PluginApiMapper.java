package ru.krug.backend.plugin.api.mapper;

import java.util.List;

import ru.krug.backend.plugin.api.dto.ChatPluginStateListResponse;
import ru.krug.backend.plugin.api.dto.ChatPluginStateResponse;
import ru.krug.backend.plugin.api.dto.PluginListResponse;
import ru.krug.backend.plugin.api.dto.PluginResponse;
import ru.krug.backend.plugin.application.model.ChatPluginStateView;
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
                plugin.icon(), plugin.permissions(), plugin.modes(), plugin.state());
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
}
