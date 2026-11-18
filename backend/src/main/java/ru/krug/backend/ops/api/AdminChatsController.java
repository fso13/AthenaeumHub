package ru.krug.backend.ops.api;

import java.util.UUID;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import ru.krug.backend.ops.api.dto.AdminChatPageResponse;
import ru.krug.backend.ops.api.mapper.AdminApiMapper;
import ru.krug.backend.ops.application.usecase.ListAdminChatsService;
import ru.krug.backend.ops.application.usecase.SoftDeleteChatService;
import ru.krug.backend.shared.application.model.Principal;

/**
 * {@code GET /admin/chats} (FR-ADM-11) and {@code DELETE /admin/chats/{chatId}} (FR-ADM-16).
 * The list service applies the platform-admin guard and access audit; the delete service
 * performs the cross-tenant soft-delete and its own audit. Delete is idempotent in effect
 * but a repeated call is a documented {@code 409 CHAT_ALREADY_DELETED}.
 */
@RestController
@RequestMapping("/api/v1/admin")
public class AdminChatsController {

    private final ListAdminChatsService chats;
    private final SoftDeleteChatService deleteChat;

    public AdminChatsController(ListAdminChatsService chats,
                                SoftDeleteChatService deleteChat) {
        this.chats = chats;
        this.deleteChat = deleteChat;
    }

    @GetMapping("/chats")
    public AdminChatPageResponse list(
            @RequestParam(value = "workspace_id", required = false) UUID workspaceId,
            @RequestParam(value = "query", required = false) String query,
            @RequestParam(value = "type", required = false) String type,
            @RequestParam(value = "cursor", required = false) String cursor,
            @RequestParam(value = "limit", required = false) Integer limit,
            Principal principal) {
        return AdminApiMapper.toPage(chats.list(principal, workspaceId, query, type, cursor,
                limit));
    }

    @DeleteMapping("/chats/{chatId}")
    public ResponseEntity<Void> delete(@PathVariable("chatId") UUID chatId,
                                       Principal principal) {
        deleteChat.delete(principal, chatId);
        return ResponseEntity.noContent().build();
    }
}
