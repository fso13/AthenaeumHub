package ru.krug.backend.plugin.application.usecase;

import java.util.List;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.plugin.application.model.MusicRoomPluginStateView;
import ru.krug.backend.plugin.application.model.MusicRoomTrackView;
import ru.krug.backend.plugin.application.model.MusicRoomTracksView;
import ru.krug.backend.plugin.application.port.MusicRoomTrackPort;
import ru.krug.backend.plugin.domain.model.MusicRoom;
import ru.krug.backend.shared.application.model.Principal;

/**
 * {@code GET /chats/{chatId}/music-room} (#94): the channel's AUDIO attachments.
 *
 * <p>Access is the shared plugin action gate: ACTIVE chat membership, the plugin must be
 * available in the chat mode and the per-chat toggle must be on ({@code 422
 * PLUGIN_NOT_ENABLED} otherwise). Any ACTIVE member may read the list. The file-center
 * query enforces the same membership and excludes E2EE/deleted/for-me-hidden rows; this
 * endpoint never exposes object keys, hashes, presigned URLs or bytes.</p>
 *
 * <p>The list is newest-first and capped at {@link MusicRoom#MAX_TRACKS}; {@code has_more}
 * tells the client whether older tracks were omitted (no cursor in this slice). No server
 * playback state or SFU session is involved: the frontend mixes audio locally into the
 * call.</p>
 */
@Service
public class GetMusicRoomService {

    private final PluginActionGate gate;
    private final MusicRoomTrackPort tracks;

    public GetMusicRoomService(PluginActionGate gate, MusicRoomTrackPort tracks) {
        this.gate = gate;
        this.tracks = tracks;
    }

    @Transactional(readOnly = true)
    public MusicRoomTracksView list(Principal principal, UUID chatId) {
        var context = gate.requireEnabled(principal, chatId, MusicRoom.PLUGIN_ID);
        List<MusicRoomTrackView> fetched = tracks.findAudio(context.workspaceId(),
                principal.userId(), chatId, MusicRoom.MAX_TRACKS + 1);
        boolean hasMore = fetched.size() > MusicRoom.MAX_TRACKS;
        List<MusicRoomTrackView> items = hasMore
                ? fetched.subList(0, MusicRoom.MAX_TRACKS)
                : fetched;
        MusicRoomPluginStateView plugin = new MusicRoomPluginStateView(MusicRoom.PLUGIN_ID,
                true, true, MusicRoom.VERSION, null);
        return new MusicRoomTracksView(chatId, plugin, items, hasMore);
    }
}
