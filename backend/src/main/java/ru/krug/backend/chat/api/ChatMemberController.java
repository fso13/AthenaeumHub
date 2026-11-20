package ru.krug.backend.chat.api;

import java.util.UUID;

import jakarta.validation.Valid;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import ru.krug.backend.chat.api.dto.AddChatMemberRequest;
import ru.krug.backend.chat.api.dto.ChangeChatMemberRoleRequest;
import ru.krug.backend.chat.api.dto.ChatMemberResponse;
import ru.krug.backend.chat.api.mapper.ChatApiMapper;
import ru.krug.backend.chat.application.model.ChatMemberAddResult;
import ru.krug.backend.chat.application.usecase.ChatMemberManagementService;
import ru.krug.backend.shared.application.model.Principal;

/**
 * Channel member management (#79).
 *
 * <pre>
 * POST   /chats/{chatId}/members              — add an ACTIVE workspace member (OWNER/ADMIN)
 * PATCH  /chats/{chatId}/members/{userId}     — change one role (OWNER/ADMIN)
 * DELETE /chats/{chatId}/members/{userId}     — soft-remove (OWNER/ADMIN) or self-leave
 * POST   /chats/{chatId}/leave                — idempotent self-leave alias
 * </pre>
 *
 * <p>The controller stays thin: authorization, the last-OWNER invariant, the advisory lock,
 * audit and error codes live in the application/domain layers.</p>
 */
@RestController
@RequestMapping("/api/v1/chats/{chatId}")
public class ChatMemberController {

    private final ChatMemberManagementService members;

    public ChatMemberController(ChatMemberManagementService members) {
        this.members = members;
    }

    @PostMapping("/members")
    public ResponseEntity<ChatMemberResponse> add(
            @PathVariable UUID chatId,
            @Valid @RequestBody AddChatMemberRequest request,
            Principal principal) {
        ChatMemberAddResult result = members.add(principal, chatId, request.userId(),
                request.role());
        return ResponseEntity.status(result.created() ? 201 : 200)
                .body(ChatApiMapper.toResponse(result.member()));
    }

    @PatchMapping("/members/{userId}")
    public ChatMemberResponse changeRole(
            @PathVariable UUID chatId,
            @PathVariable UUID userId,
            @Valid @RequestBody ChangeChatMemberRoleRequest request,
            Principal principal) {
        return ChatApiMapper.toResponse(members.changeRole(principal, chatId, userId,
                request.role()));
    }

    @DeleteMapping("/members/{userId}")
    public ResponseEntity<Void> remove(
            @PathVariable UUID chatId,
            @PathVariable UUID userId,
            Principal principal) {
        members.remove(principal, chatId, userId);
        return ResponseEntity.noContent().build();
    }

    @PostMapping("/leave")
    public ResponseEntity<Void> leave(@PathVariable UUID chatId, Principal principal) {
        members.leave(principal, chatId);
        return ResponseEntity.noContent().build();
    }
}
