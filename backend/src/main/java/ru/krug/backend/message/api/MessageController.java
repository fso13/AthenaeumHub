package ru.krug.backend.message.api;

import java.util.Map;
import java.util.UUID;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import ru.krug.backend.message.api.dto.MessageCreateRequest;
import ru.krug.backend.message.api.dto.MessagePageResponse;
import ru.krug.backend.message.api.dto.MessageResponse;
import ru.krug.backend.message.api.mapper.MessageApiMapper;
import ru.krug.backend.message.application.command.ListMessagesQuery;
import ru.krug.backend.message.application.command.SendMessageCommand;
import ru.krug.backend.message.application.model.MessageCreateInput;
import ru.krug.backend.message.application.model.SendMessageResult;
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

    public MessageController(SendMessageUseCase sendMessageUseCase,
                             MessageQueryHandler messageQueryHandler) {
        this.sendMessageUseCase = sendMessageUseCase;
        this.messageQueryHandler = messageQueryHandler;
    }

    @GetMapping
    public MessagePageResponse list(@PathVariable UUID chatId,
                                    @RequestParam(value = "after_seq", required = false) Long afterSeq,
                                    @RequestParam(value = "before_seq", required = false) Long beforeSeq,
                                    @RequestParam(value = "limit", required = false) Integer limit,
                                    Principal principal) {
        return MessageApiMapper.toResponse(messageQueryHandler.list(
                new ListMessagesQuery(principal, chatId, afterSeq, beforeSeq, limit)));
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
                request.attachmentIds(), request.envelopes());
        SendMessageResult result = sendMessageUseCase.send(
                new SendMessageCommand(principal, chatId, key, input));
        ResponseEntity.BodyBuilder builder = ResponseEntity.status(result.status());
        if (result.replay()) {
            builder.header("Idempotent-Replay", "true");
        }
        return builder.body(MessageApiMapper.toCreateResponse(result.message(),
                result.coverage()));
    }
}
