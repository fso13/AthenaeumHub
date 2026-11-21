package ru.krug.backend.plugin.api.mapper;

import java.util.List;

import ru.krug.backend.plugin.api.dto.MusicRoomChatResponse;
import ru.krug.backend.plugin.api.dto.MusicRoomOpenResponse;
import ru.krug.backend.plugin.api.dto.MusicRoomPluginResponse;
import ru.krug.backend.plugin.api.dto.MusicRoomTrackResponse;
import ru.krug.backend.plugin.api.dto.MusicRoomTracksResponse;
import ru.krug.backend.plugin.application.model.MusicRoomChatView;
import ru.krug.backend.plugin.application.model.MusicRoomOpenView;
import ru.krug.backend.plugin.application.model.MusicRoomPluginStateView;
import ru.krug.backend.plugin.application.model.MusicRoomTrackView;
import ru.krug.backend.plugin.application.model.MusicRoomTracksView;

/** Music-room application read models -> API DTOs. No domain or persistence imports. */
public final class MusicRoomApiMapper {

    private MusicRoomApiMapper() {
    }

    public static MusicRoomOpenResponse toResponse(MusicRoomOpenView view) {
        return new MusicRoomOpenResponse(toResponse(view.chat()), toResponse(view.plugin()),
                view.created());
    }

    public static MusicRoomTracksResponse toResponse(MusicRoomTracksView view) {
        List<MusicRoomTrackResponse> items = view.items().stream()
                .map(MusicRoomApiMapper::toResponse)
                .toList();
        return new MusicRoomTracksResponse(view.chatId(), toResponse(view.plugin()), items,
                view.hasMore());
    }

    public static MusicRoomChatResponse toResponse(MusicRoomChatView chat) {
        return new MusicRoomChatResponse(chat.id(), chat.type(), chat.securityMode(),
                chat.visibility(), chat.peerId(), chat.peerHasE2eeCapableDevices(),
                chat.name(), chat.description(), chat.keyEpoch(), chat.lastSeq(),
                chat.unreadCount(), chat.createdAt(), chat.coverFileId(), chat.avatarFileId(),
                chat.readOnly(), chat.joinPolicy(), chat.archived());
    }

    public static MusicRoomPluginResponse toResponse(MusicRoomPluginStateView plugin) {
        return new MusicRoomPluginResponse(plugin.pluginId(), plugin.enabled(),
                plugin.available(), plugin.version(), plugin.reason());
    }

    public static MusicRoomTrackResponse toResponse(MusicRoomTrackView track) {
        return new MusicRoomTrackResponse(track.id(), track.messageId(), track.filename(),
                track.mimeType(), track.durationMs(), track.artworkUrl(), track.title(),
                track.artist(), track.sizeBytes(), track.createdAt());
    }
}
