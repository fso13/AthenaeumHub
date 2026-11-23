package ru.krug.backend.bot.api;

import java.util.UUID;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import ru.krug.backend.bot.api.dto.BotCommandAcceptedResponse;
import ru.krug.backend.bot.api.dto.BotCommandInvokeRequest;
import ru.krug.backend.bot.application.usecase.InvokeBotCommandService;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.error.DomainException;

/**
 * {@code POST /chats/{chatId}/commands}: an active chat member invokes a slash command owned
 * by an installed+enabled bot. The endpoint returns 202 with the queued delivery id and
 * creates no chat message; the bot answers later through its one-time response URL.
 */
@RestController
@RequestMapping("/api/v1/chats/{chatId}/commands")
public class BotCommandController {

    private final InvokeBotCommandService invokeCommand;

    public BotCommandController(InvokeBotCommandService invokeCommand) {
        this.invokeCommand = invokeCommand;
    }

    @PostMapping
    public ResponseEntity<BotCommandAcceptedResponse> invoke(
            @PathVariable UUID chatId,
            @RequestBody(required = false) BotCommandInvokeRequest request,
            Principal principal) {
        if (request == null) {
            throw DomainException.badRequest("Request body is required",
                    java.util.Map.of("reason", "missing_body"));
        }
        var result = invokeCommand.invoke(principal, chatId, request.command(), request.args());
        return ResponseEntity.status(202)
                .body(new BotCommandAcceptedResponse(result.deliveryId()));
    }
}
