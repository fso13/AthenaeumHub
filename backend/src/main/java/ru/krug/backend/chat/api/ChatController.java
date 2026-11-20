package ru.krug.backend.chat.api;

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
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import ru.krug.backend.chat.api.dto.ChatAvatarRequest;
import ru.krug.backend.chat.api.dto.ChatAvatarResponse;
import ru.krug.backend.chat.api.dto.ChatCoverRequest;
import ru.krug.backend.chat.api.dto.ChatCreateRequest;
import ru.krug.backend.chat.api.dto.ChatListResponse;
import ru.krug.backend.chat.api.dto.ChatMemberIdsResponse;
import ru.krug.backend.chat.api.dto.ChatPermissionsResponse;
import ru.krug.backend.chat.api.dto.ChatPermissionsUpdateRequest;
import ru.krug.backend.chat.api.dto.ChatResponse;
import ru.krug.backend.chat.api.dto.ChatUpdateRequest;
import ru.krug.backend.chat.api.dto.ReadRequest;
import ru.krug.backend.chat.api.mapper.ChatApiMapper;
import ru.krug.backend.chat.application.model.ChatAvatarView;
import ru.krug.backend.chat.application.model.CreateChatResult;
import ru.krug.backend.chat.application.usecase.ChatArchiveService;
import ru.krug.backend.chat.application.usecase.ChatAvatarService;
import ru.krug.backend.chat.application.usecase.ChatCoverService;
import ru.krug.backend.chat.application.usecase.ChatCreateService;
import ru.krug.backend.chat.application.usecase.ChatDeletionService;
import ru.krug.backend.chat.application.usecase.ChatMembersQueryService;
import ru.krug.backend.chat.application.usecase.ChatPermissionsService;
import ru.krug.backend.chat.application.usecase.ChatQueryService;
import ru.krug.backend.chat.application.usecase.ChatUpdateService;
import ru.krug.backend.chat.application.usecase.MarkReadService;
import ru.krug.backend.shared.api.RequestHeaders;
import ru.krug.backend.shared.application.model.Principal;

/**
 * Chat lifecycle and channel settings (D1-BE3 + P0-2 / #80).
 *
 * <pre>
 * GET    /workspaces/{workspaceId}/chats            — list (archived=false|true)
 * POST   /workspaces/{workspaceId}/chats            — create
 * PATCH  /chats/{chatId}                            — name/description + channel settings
 * DELETE /chats/{chatId}                            — soft delete (channel OWNER)
 * POST   /chats/{chatId}/cover                      — set a cover from an existing attachment
 * DELETE /chats/{chatId}/cover                      — clear the cover
 * POST   /chats/{chatId}/avatar                     — set the channel icon/avatar
 * DELETE /chats/{chatId}/avatar                     — clear the avatar
 * GET    /chats/{chatId}/avatar                     — 302 to a presigned object URL
 * GET    /chats/{chatId}/permissions                — effective rights matrix
 * PATCH  /chats/{chatId}/permissions                — change rights (chat OWNER/ADMIN)
 * POST   /chats/{chatId}/archive                    — per-user archive
 * POST   /chats/{chatId}/unarchive                  — per-user unarchive
 * </pre>
 *
 * <p>The controller stays thin: authorization, validation, audit and error codes live in the
 * application/domain layers. Pins live in {@link ChatPinController}.</p>
 */
@RestController
@RequestMapping("/api/v1")
public class ChatController {

    private final ChatQueryService chatQueryService;
    private final MarkReadService markReadService;
    private final ChatCreateService chatCreateService;
    private final ChatUpdateService chatUpdateService;
    private final ChatCoverService chatCoverService;
    private final ChatAvatarService chatAvatarService;
    private final ChatPermissionsService chatPermissionsService;
    private final ChatArchiveService chatArchiveService;
    private final ChatDeletionService chatDeletionService;
    private final ChatMembersQueryService chatMembersQueryService;

    public ChatController(ChatQueryService chatQueryService, MarkReadService markReadService,
                          ChatCreateService chatCreateService,
                          ChatUpdateService chatUpdateService,
                          ChatCoverService chatCoverService,
                          ChatAvatarService chatAvatarService,
                          ChatPermissionsService chatPermissionsService,
                          ChatArchiveService chatArchiveService,
                          ChatDeletionService chatDeletionService,
                          ChatMembersQueryService chatMembersQueryService) {
        this.chatQueryService = chatQueryService;
        this.markReadService = markReadService;
        this.chatCreateService = chatCreateService;
        this.chatUpdateService = chatUpdateService;
        this.chatCoverService = chatCoverService;
        this.chatAvatarService = chatAvatarService;
        this.chatPermissionsService = chatPermissionsService;
        this.chatArchiveService = chatArchiveService;
        this.chatDeletionService = chatDeletionService;
        this.chatMembersQueryService = chatMembersQueryService;
    }

    @GetMapping("/workspaces/{workspaceId}/chats")
    public ChatListResponse listChats(@PathVariable UUID workspaceId,
                                      @RequestParam(required = false) Boolean archived,
                                      Principal principal) {
        return ChatApiMapper.toResponse(
                chatQueryService.listChats(principal, workspaceId, archived));
    }

    @PostMapping("/workspaces/{workspaceId}/chats")
    public ResponseEntity<ChatResponse> createChat(
            @PathVariable UUID workspaceId,
            @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey,
            @Valid @RequestBody(required = false) ChatCreateRequest request,
            Principal principal) {
        java.util.UUID key = RequestHeaders.requireUuid(idempotencyKey, "Idempotency-Key");
        if (request == null) {
            throw ru.krug.backend.shared.error.DomainException.badRequest(
                    "Request body is required",
                    java.util.Map.of("reason", "missing_body"));
        }
        CreateChatResult result = chatCreateService.create(principal, workspaceId,
                new ChatCreateService.ChatCreateCommand(request.type(), request.peerId(),
                        request.name(), request.visibility(), request.memberIds()), key);
        return ResponseEntity.status(result.status())
                .body(ChatApiMapper.toResponse(result.chat()));
    }

    @PatchMapping("/chats/{chatId}")
    public ChatResponse updateChat(@PathVariable UUID chatId,
                                   @RequestBody ChatUpdateRequest request,
                                   Principal principal) {
        return ChatApiMapper.toResponse(chatUpdateService.update(principal, chatId,
                ChatApiMapper.toCommand(request)));
    }

    @DeleteMapping("/chats/{chatId}")
    public ResponseEntity<Void> deleteChat(@PathVariable UUID chatId, Principal principal) {
        chatDeletionService.delete(principal, chatId);
        return ResponseEntity.noContent().build();
    }

    @PostMapping("/chats/{chatId}/cover")
    public ChatResponse setCover(@PathVariable UUID chatId,
                                 @Valid @RequestBody ChatCoverRequest request,
                                 Principal principal) {
        return ChatApiMapper.toResponse(
                chatCoverService.setCover(principal, chatId, request.fileId()));
    }

    @DeleteMapping("/chats/{chatId}/cover")
    public ResponseEntity<Void> removeCover(@PathVariable UUID chatId, Principal principal) {
        chatCoverService.removeCover(principal, chatId);
        return ResponseEntity.noContent().build();
    }

    @PostMapping("/chats/{chatId}/avatar")
    public ChatResponse setAvatar(@PathVariable UUID chatId,
                                  @Valid @RequestBody ChatAvatarRequest request,
                                  Principal principal) {
        return ChatApiMapper.toResponse(
                chatAvatarService.setAvatar(principal, chatId, request.fileId()));
    }

    @DeleteMapping("/chats/{chatId}/avatar")
    public ResponseEntity<Void> removeAvatar(@PathVariable UUID chatId, Principal principal) {
        chatAvatarService.removeAvatar(principal, chatId);
        return ResponseEntity.noContent().build();
    }

    @GetMapping("/chats/{chatId}/avatar")
    public ResponseEntity<ChatAvatarResponse> downloadAvatar(@PathVariable UUID chatId,
                                                             Principal principal) {
        ChatAvatarView view = chatAvatarService.download(principal, chatId);
        return ResponseEntity.status(HttpStatus.FOUND)
                .header("Location", view.url())
                .body(new ChatAvatarResponse(view.url(), view.expiresAt()));
    }

    @GetMapping("/chats/{chatId}/permissions")
    public ChatPermissionsResponse permissions(@PathVariable UUID chatId,
                                               Principal principal) {
        return ChatApiMapper.toResponse(chatPermissionsService.get(principal, chatId));
    }

    @PatchMapping("/chats/{chatId}/permissions")
    public ChatPermissionsResponse updatePermissions(
            @PathVariable UUID chatId,
            @RequestBody ChatPermissionsUpdateRequest request,
            Principal principal) {
        return ChatApiMapper.toResponse(chatPermissionsService.patch(principal, chatId,
                ChatApiMapper.toRightsMap(request)));
    }

    @PostMapping("/chats/{chatId}/archive")
    public ResponseEntity<Void> archive(@PathVariable UUID chatId, Principal principal) {
        chatArchiveService.archive(principal, chatId);
        return ResponseEntity.noContent().build();
    }

    @PostMapping("/chats/{chatId}/unarchive")
    public ResponseEntity<Void> unarchive(@PathVariable UUID chatId, Principal principal) {
        chatArchiveService.unarchive(principal, chatId);
        return ResponseEntity.noContent().build();
    }

    @GetMapping("/chats/{chatId}/members")
    public ChatMemberIdsResponse listMembers(@PathVariable UUID chatId, Principal principal) {
        return ChatApiMapper.toResponse(chatMembersQueryService.list(principal, chatId));
    }

    @PostMapping("/chats/{chatId}/read")
    public ResponseEntity<Void> markRead(@PathVariable UUID chatId,
                                         @RequestHeader(value = "Idempotency-Key", required = false)
                                         String idempotencyKey,
                                         @Valid @RequestBody ReadRequest request,
                                         Principal principal) {
        RequestHeaders.requireUuid(idempotencyKey, "Idempotency-Key");
        markReadService.markRead(principal, chatId, request.lastSeq());
        return ResponseEntity.noContent().build();
    }
}
