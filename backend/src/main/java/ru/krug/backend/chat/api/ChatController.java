package ru.krug.backend.chat.api;

import java.util.UUID;

import jakarta.validation.Valid;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import ru.krug.backend.chat.api.dto.ChatCreateRequest;
import ru.krug.backend.chat.api.dto.ChatListResponse;
import ru.krug.backend.chat.api.dto.ChatMemberIdsResponse;
import ru.krug.backend.chat.api.dto.ChatResponse;
import ru.krug.backend.chat.api.dto.ChatUpdateRequest;
import ru.krug.backend.chat.api.dto.ReadRequest;
import ru.krug.backend.chat.api.mapper.ChatApiMapper;
import ru.krug.backend.chat.application.model.CreateChatResult;
import ru.krug.backend.chat.application.usecase.ChatCreateService;
import ru.krug.backend.chat.application.command.ChatUpdateCommand;
import ru.krug.backend.chat.application.usecase.ChatQueryService;
import ru.krug.backend.chat.application.usecase.ChatMembersQueryService;
import ru.krug.backend.chat.application.usecase.ChatUpdateService;
import ru.krug.backend.chat.application.usecase.MarkReadService;
import ru.krug.backend.shared.api.RequestHeaders;
import ru.krug.backend.shared.application.model.Principal;

@RestController
@RequestMapping("/api/v1")
public class ChatController {

    private final ChatQueryService chatQueryService;
    private final MarkReadService markReadService;
    private final ChatCreateService chatCreateService;
    private final ChatUpdateService chatUpdateService;
    private final ChatMembersQueryService chatMembersQueryService;

    public ChatController(ChatQueryService chatQueryService, MarkReadService markReadService,
                          ChatCreateService chatCreateService,
                          ChatUpdateService chatUpdateService,
                          ChatMembersQueryService chatMembersQueryService) {
        this.chatQueryService = chatQueryService;
        this.markReadService = markReadService;
        this.chatCreateService = chatCreateService;
        this.chatUpdateService = chatUpdateService;
        this.chatMembersQueryService = chatMembersQueryService;
    }

    @GetMapping("/workspaces/{workspaceId}/chats")
    public ChatListResponse listChats(@PathVariable UUID workspaceId, Principal principal) {
        return ChatApiMapper.toResponse(chatQueryService.listChats(principal, workspaceId));
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
                new ChatUpdateCommand(request.name(), request.description())));
    }

    @GetMapping("/chats/{chatId}/members")
    public ChatMemberIdsResponse listMembers(@PathVariable UUID chatId, Principal principal) {
        return new ChatMemberIdsResponse(chatMembersQueryService.list(principal, chatId));
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
