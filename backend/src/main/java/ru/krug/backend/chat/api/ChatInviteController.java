package ru.krug.backend.chat.api;

import java.util.UUID;

import jakarta.validation.Valid;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import ru.krug.backend.chat.api.dto.ChatInviteCreateRequest;
import ru.krug.backend.chat.api.dto.ChatInviteCreatedResponse;
import ru.krug.backend.chat.api.dto.ChatInviteListResponse;
import ru.krug.backend.chat.api.dto.InviteAcceptResponse;
import ru.krug.backend.chat.api.mapper.ChatApiMapper;
import ru.krug.backend.chat.application.command.ChatInviteCreateCommand;
import ru.krug.backend.chat.application.usecase.ChatInviteService;
import ru.krug.backend.shared.application.model.Principal;

/**
 * Channel invite links (#79).
 *
 * <pre>
 * GET    /chats/{chatId}/invites               — metadata only (OWNER/ADMIN)
 * POST   /chats/{chatId}/invites               — create; raw token returned once
 * DELETE /chats/{chatId}/invites/{inviteId}    — revoke (idempotent)
 * POST   /invites/{token}/accept               — join with the invite role (rate-limited)
 * </pre>
 *
 * <p>No raw token, hash or email ever leaves the backend except the one-time create
 * response. The token is not an Idempotency-Key request: repeated POSTs mint new links.</p>
 */
@RestController
@RequestMapping("/api/v1")
public class ChatInviteController {

    private final ChatInviteService invites;

    public ChatInviteController(ChatInviteService invites) {
        this.invites = invites;
    }

    @GetMapping("/chats/{chatId}/invites")
    public ChatInviteListResponse list(@PathVariable UUID chatId, Principal principal) {
        return ChatApiMapper.toInviteListResponse(invites.list(principal, chatId));
    }

    @PostMapping("/chats/{chatId}/invites")
    public ResponseEntity<ChatInviteCreatedResponse> create(
            @PathVariable UUID chatId,
            @Valid @RequestBody(required = false) ChatInviteCreateRequest request,
            Principal principal) {
        ChatInviteCreateCommand command = request == null
                ? new ChatInviteCreateCommand(null, null, null)
                : new ChatInviteCreateCommand(request.role(), request.maxUses(),
                        request.expiresInSeconds());
        return ResponseEntity.status(201)
                .body(ChatApiMapper.toResponse(invites.create(principal, chatId, command)));
    }

    @DeleteMapping("/chats/{chatId}/invites/{inviteId}")
    public ResponseEntity<Void> revoke(
            @PathVariable UUID chatId,
            @PathVariable UUID inviteId,
            Principal principal) {
        invites.revoke(principal, chatId, inviteId);
        return ResponseEntity.noContent().build();
    }

    @PostMapping("/invites/{token}/accept")
    public InviteAcceptResponse accept(@PathVariable String token, Principal principal) {
        return ChatApiMapper.toResponse(invites.accept(principal, token));
    }
}
