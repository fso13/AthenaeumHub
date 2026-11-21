package ru.krug.backend.plugin.api;

import java.util.UUID;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import ru.krug.backend.plugin.api.dto.MusicRoomOpenResponse;
import ru.krug.backend.plugin.api.dto.MusicRoomTracksResponse;
import ru.krug.backend.plugin.api.mapper.MusicRoomApiMapper;
import ru.krug.backend.plugin.application.model.MusicRoomOpenView;
import ru.krug.backend.plugin.application.usecase.GetMusicRoomService;
import ru.krug.backend.plugin.application.usecase.OpenMusicRoomService;
import ru.krug.backend.shared.application.model.Principal;

/**
 * Built-in {@code music-room} plugin (#94).
 *
 * <pre>
 * POST /workspaces/{workspaceId}/music-room — find-or-create the workspace room (idempotent)
 * GET  /chats/{chatId}/music-room          — AUDIO attachments of a chat with the plugin on
 * </pre>
 *
 * <p>The room is an ordinary managed GROUP channel; the server keeps no audio, playback
 * state or SFU session. The frontend lists the AUDIO attachments and mixes them locally into
 * the call. See {@code backend/MUSIC-ROOM-REPORT.md}.</p>
 */
@RestController
@RequestMapping("/api/v1")
public class MusicRoomController {

    private final OpenMusicRoomService openMusicRoom;
    private final GetMusicRoomService getMusicRoom;

    public MusicRoomController(OpenMusicRoomService openMusicRoom,
                               GetMusicRoomService getMusicRoom) {
        this.openMusicRoom = openMusicRoom;
        this.getMusicRoom = getMusicRoom;
    }

    /**
     * Idempotent find-or-create: 201 only when this request created the channel, 200 when the
     * existing tagged room is returned. The body is always chat + plugin state.
     */
    @PostMapping("/workspaces/{workspaceId}/music-room")
    public ResponseEntity<MusicRoomOpenResponse> open(@PathVariable UUID workspaceId,
                                                      Principal principal) {
        MusicRoomOpenView view = openMusicRoom.open(principal, workspaceId);
        return ResponseEntity.status(view.created() ? HttpStatus.CREATED : HttpStatus.OK)
                .body(MusicRoomApiMapper.toResponse(view));
    }

    /** Any ACTIVE chat member may list the room's CLEAN AUDIO attachments. */
    @GetMapping("/chats/{chatId}/music-room")
    public MusicRoomTracksResponse tracks(@PathVariable UUID chatId, Principal principal) {
        return MusicRoomApiMapper.toResponse(getMusicRoom.list(principal, chatId));
    }
}
