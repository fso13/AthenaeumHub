package ru.krug.backend.room.api;

import java.util.UUID;

import jakarta.validation.Valid;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import ru.krug.backend.room.api.dto.CreateRoomRequest;
import ru.krug.backend.room.api.dto.RoomListResponse;
import ru.krug.backend.room.api.dto.RoomResponse;
import ru.krug.backend.room.api.dto.UpdateRoomRequest;
import ru.krug.backend.room.api.mapper.RoomApiMapper;
import ru.krug.backend.room.application.usecase.CloseRoomService;
import ru.krug.backend.room.application.usecase.CreateRoomService;
import ru.krug.backend.room.application.usecase.GetRoomService;
import ru.krug.backend.room.application.usecase.ListRoomsService;
import ru.krug.backend.room.application.usecase.RenameRoomService;
import ru.krug.backend.room.application.usecase.RoomPresenceService;
import ru.krug.backend.shared.application.model.Principal;

/**
 * Workspace video rooms (#105).
 *
 * <pre>
 * GET    /workspaces/{workspaceId}/rooms              — ACTIVE rooms + live participants
 * POST   /workspaces/{workspaceId}/rooms              — room + managed GROUP channel
 * GET    /rooms/{roomId}                              — room detail (optional)
 * PATCH  /workspaces/{workspaceId}/rooms/{roomId}     — rename (creator/OWNER/ADMIN)
 * DELETE /workspaces/{workspaceId}/rooms/{roomId}     — soft-close (creator/OWNER)
 * POST   /rooms/{roomId}/presence                     — join/heartbeat (30 s TTL)
 * DELETE /rooms/{roomId}/presence                     — leave (idempotent)
 * </pre>
 *
 * <p>The room itself keeps no call/SFU/media state: the backing managed GROUP channel is
 * used by the existing WebRTC signalling, and presence is a REST heartbeat exported to the
 * frontend through the 5-second poll. See {@code backend/ROOMS-REPORT.md}.</p>
 */
@RestController
@RequestMapping("/api/v1")
public class RoomController {

    private final CreateRoomService createRoom;
    private final ListRoomsService listRooms;
    private final GetRoomService getRoom;
    private final RenameRoomService renameRoom;
    private final CloseRoomService closeRoom;
    private final RoomPresenceService presence;

    public RoomController(CreateRoomService createRoom, ListRoomsService listRooms,
                          GetRoomService getRoom, RenameRoomService renameRoom,
                          CloseRoomService closeRoom, RoomPresenceService presence) {
        this.createRoom = createRoom;
        this.listRooms = listRooms;
        this.getRoom = getRoom;
        this.renameRoom = renameRoom;
        this.closeRoom = closeRoom;
        this.presence = presence;
    }

    @GetMapping("/workspaces/{workspaceId}/rooms")
    public RoomListResponse list(@PathVariable UUID workspaceId, Principal principal) {
        return RoomApiMapper.toResponse(listRooms.list(principal, workspaceId));
    }

    @PostMapping("/workspaces/{workspaceId}/rooms")
    public ResponseEntity<RoomResponse> create(@PathVariable UUID workspaceId,
                                               @Valid @RequestBody CreateRoomRequest request,
                                               Principal principal) {
        RoomResponse response = RoomApiMapper.toResponse(
                createRoom.create(principal, workspaceId, request.name()));
        return ResponseEntity.status(HttpStatus.CREATED).body(response);
    }

    @GetMapping("/rooms/{roomId}")
    public RoomResponse get(@PathVariable UUID roomId, Principal principal) {
        return RoomApiMapper.toResponse(getRoom.get(principal, roomId));
    }

    @PatchMapping("/workspaces/{workspaceId}/rooms/{roomId}")
    public RoomResponse rename(@PathVariable UUID workspaceId, @PathVariable UUID roomId,
                               @Valid @RequestBody UpdateRoomRequest request,
                               Principal principal) {
        return RoomApiMapper.toResponse(
                renameRoom.rename(principal, workspaceId, roomId, request.name()));
    }

    @DeleteMapping("/workspaces/{workspaceId}/rooms/{roomId}")
    public ResponseEntity<Void> close(@PathVariable UUID workspaceId,
                                      @PathVariable UUID roomId, Principal principal) {
        closeRoom.close(principal, workspaceId, roomId);
        return ResponseEntity.noContent().build();
    }

    /** Join or refresh the heartbeat; the row is returned after {@code 204}. */
    @PostMapping("/rooms/{roomId}/presence")
    public ResponseEntity<Void> heartbeat(@PathVariable UUID roomId, Principal principal) {
        presence.heartbeat(principal, roomId);
        return ResponseEntity.noContent().build();
    }

    /** Idempotent leave: a missing row is still {@code 204}. */
    @DeleteMapping("/rooms/{roomId}/presence")
    public ResponseEntity<Void> leave(@PathVariable UUID roomId, Principal principal) {
        presence.leave(principal, roomId);
        return ResponseEntity.noContent().build();
    }
}
