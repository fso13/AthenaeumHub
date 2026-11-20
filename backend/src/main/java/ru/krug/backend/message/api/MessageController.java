package ru.krug.backend.message.api;

import java.util.Map;
import java.util.UUID;

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

import ru.krug.backend.message.api.dto.MessageCreateRequest;
import ru.krug.backend.message.api.dto.MessageEditRequest;
import ru.krug.backend.message.api.dto.MessagePageResponse;
import ru.krug.backend.message.api.dto.MessageResponse;
import ru.krug.backend.message.api.dto.ReactionCreateRequest;
import ru.krug.backend.message.api.dto.ReactionSummaryResponse;
import ru.krug.backend.message.api.mapper.MessageApiMapper;
import ru.krug.backend.message.application.command.DeleteMessageScope;
import ru.krug.backend.message.application.command.ListMessagesQuery;
import ru.krug.backend.message.application.command.SendMessageCommand;
import ru.krug.backend.message.application.model.MessageCreateInput;
import ru.krug.backend.message.application.model.MessageEditInput;
import ru.krug.backend.message.application.model.ReactionSummaryView;
import ru.krug.backend.message.application.model.SendMessageResult;
import ru.krug.backend.message.application.usecase.MessageActionsService;
import ru.krug.backend.message.application.usecase.MessageQueryHandler;
import ru.krug.backend.message.application.usecase.SendMessageUseCase;
import ru.krug.backend.shared.api.RequestHeaders;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.error.DomainException;

@RestController
@RequestMapping("/api/v1/chats/{chatId}/messages")
public class MessageController {

    private final SendMessageUseCase sendMessageUseCase;
    private final MessageQueryHandler messageQueryHandler;
    private final MessageActionsService messageActionsService;

    public MessageController(SendMessageUseCase sendMessageUseCase,
                             MessageQueryHandler messageQueryHandler,
                             MessageActionsService messageActionsService) {
        this.sendMessageUseCase = sendMessageUseCase;
        this.messageQueryHandler = messageQueryHandler;
        this.messageActionsService = messageActionsService;
    }

    @GetMapping
    public MessagePageResponse list(@PathVariable UUID chatId,
                                    @RequestParam(value = "after_seq", required = false) Long afterSeq,
                                    @RequestParam(value = "before_seq", required = false) Long beforeSeq,
                                    @RequestParam(value = "limit", required = false) Integer limit,
                                    @RequestParam(value = "thread_root_id", required = false)
                                    UUID threadRootId,
                                    Principal principal) {
        return MessageApiMapper.toResponse(messageQueryHandler.list(
                new ListMessagesQuery(principal, chatId, afterSeq, beforeSeq, limit,
                        threadRootId)));
    }

    @PostMapping
    public ResponseEntity<MessageResponse> send(
            @PathVariable UUID chatId,
            @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey,
            @RequestBody(required = false) MessageCreateRequest request,
            Principal principal) {
        UUID key = RequestHeaders.requireUuid(idempotencyKey, "Idempotency-Key");
        if (request == null) {
            throw DomainException.badRequest("Request body is required",
                    Map.of("reason", "missing_body"));
        }
        MessageCreateInput input = new MessageCreateInput(request.clientMessageId(),
                request.type(), request.text(), request.stickerId(), request.replyToId(),
                request.threadRootId(), request.attachmentIds(), request.envelopes(),
                request.mentions(), Boolean.TRUE.equals(request.mentionAll()));
        SendMessageResult result = sendMessageUseCase.send(
                new SendMessageCommand(principal, chatId, key, input));
        ResponseEntity.BodyBuilder builder = ResponseEntity.status(result.status());
        if (result.replay()) {
            builder.header("Idempotent-Replay", "true");
        }
        return builder.body(MessageApiMapper.toCreateResponse(result.message(),
                result.coverage()));
    }

    @PatchMapping("/{messageId}")
    public MessageResponse edit(@PathVariable UUID chatId, @PathVariable UUID messageId,
                                @RequestBody(required = false) MessageEditRequest request,
                                Principal principal) {
        if (request == null) {
            throw DomainException.badRequest("Request body is required",
                    Map.of("reason", "missing_body"));
        }
        return MessageApiMapper.toResponse(messageActionsService.edit(principal, chatId,
                messageId, new MessageEditInput(request.text(), request.version())));
    }

    @DeleteMapping("/{messageId}")
    public ResponseEntity<Void> delete(@PathVariable UUID chatId, @PathVariable UUID messageId,
                                       @RequestParam(value = "scope", required = false)
                                       String scope,
                                       Principal principal) {
        messageActionsService.delete(principal, chatId, messageId,
                DeleteMessageScope.parse(scope));
        return ResponseEntity.noContent().build();
    }

    @PostMapping("/{messageId}/reactions")
    public ReactionSummaryResponse react(@PathVariable UUID chatId,
                                         @PathVariable UUID messageId,
                                         @RequestBody(required = false) ReactionCreateRequest request,
                                         Principal principal) {
        if (request == null) {
            throw DomainException.badRequest("Request body is required",
                    Map.of("reason", "missing_body"));
        }
        ReactionSummaryView reaction = messageActionsService.react(principal, chatId,
                messageId, request.emoji());
        return new ReactionSummaryResponse(reaction.emoji(), reaction.count(), reaction.me());
    }

    @DeleteMapping("/{messageId}/reactions/{emoji}")
    public ResponseEntity<Void> unreact(@PathVariable UUID chatId,
                                        @PathVariable UUID messageId,
                                        @PathVariable String emoji,
                                        Principal principal) {
        messageActionsService.unreact(principal, chatId, messageId, emoji);
        return ResponseEntity.noContent().build();
    }
}
