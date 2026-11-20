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

import ru.krug.backend.chat.api.dto.ChatPinListResponse;
import ru.krug.backend.chat.api.dto.ChatPinRequest;
import ru.krug.backend.chat.api.dto.ChatPinResponse;
import ru.krug.backend.chat.api.mapper.ChatApiMapper;
import ru.krug.backend.chat.application.model.ChatPinResult;
import ru.krug.backend.chat.application.usecase.ChatPinService;
import ru.krug.backend.shared.application.model.Principal;

/**
 * Channel pins (P0-2 / #80).
 *
 * <pre>
 * GET    /chats/{chatId}/pins                  — newest pin first, metadata only
 * POST   /chats/{chatId}/pins                  — 201 first pin, 200 idempotent repeat
 * DELETE /chats/{chatId}/pins/{messageId}      — 204, idempotent
 * </pre>
 *
 * <p>Listing requires an ACTIVE participant; pin/unpin requires {@code pin_messages}
 * (OWNER/ADMIN/MODERATOR by default). Pins are metadata only and are rejected for E2EE
 * chats. The controller contains no authorization logic.</p>
 */
@RestController
@RequestMapping("/api/v1/chats/{chatId}/pins")
public class ChatPinController {

    private final ChatPinService pins;

    public ChatPinController(ChatPinService pins) {
        this.pins = pins;
    }

    @GetMapping
    public ChatPinListResponse list(@PathVariable UUID chatId, Principal principal) {
        return ChatApiMapper.toPinListResponse(pins.list(principal, chatId));
    }

    @PostMapping
    public ResponseEntity<ChatPinResponse> pin(@PathVariable UUID chatId,
                                               @Valid @RequestBody ChatPinRequest request,
                                               Principal principal) {
        ChatPinResult result = pins.pin(principal, chatId, request.messageId());
        return ResponseEntity.status(result.created() ? 201 : 200)
                .body(ChatApiMapper.toResponse(result.pin()));
    }

    @DeleteMapping("/{messageId}")
    public ResponseEntity<Void> unpin(@PathVariable UUID chatId,
                                      @PathVariable UUID messageId,
                                      Principal principal) {
        pins.unpin(principal, chatId, messageId);
        return ResponseEntity.noContent().build();
    }
}
