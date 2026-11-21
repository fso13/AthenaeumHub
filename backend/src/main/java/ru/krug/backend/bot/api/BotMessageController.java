package ru.krug.backend.bot.api;

import java.util.UUID;

import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import ru.krug.backend.bot.api.dto.BotMessageCreateRequest;
import ru.krug.backend.bot.application.command.BotMessageCommand;
import ru.krug.backend.bot.application.model.BotMessageResult;
import ru.krug.backend.bot.application.model.BotPrincipal;
import ru.krug.backend.bot.application.usecase.BotMessageService;
import ru.krug.backend.message.api.dto.MessageResponse;
import ru.krug.backend.message.api.mapper.MessageApiMapper;
import ru.krug.backend.shared.api.RequestHeaders;
import ru.krug.backend.shared.error.DomainException;

/**
 * Bot-token API. This is the only endpoint reachable with a bot bearer token; the dedicated
 * security chain matches {@code /api/v1/bots/**} and the raw token is validated by
 * {@link ru.krug.backend.bot.infrastructure.security.BotTokenAuthenticationFilter}.
 *
 * <p>A bot can never read messages, call, upload or touch files: those paths are served by
 * the JWT chain and reject a bot token with 401.</p>
 */
@RestController
@RequestMapping("/api/v1/bots/{botId}/messages")
public class BotMessageController {

    private final BotMessageService botMessageService;

    public BotMessageController(BotMessageService botMessageService) {
        this.botMessageService = botMessageService;
    }

    @PostMapping
    public ResponseEntity<MessageResponse> send(
            @PathVariable UUID botId,
            @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey,
            @RequestBody(required = false) BotMessageCreateRequest request,
            Authentication authentication) {
        BotPrincipal principal = botPrincipal(authentication, botId);
        UUID key = RequestHeaders.requireUuid(idempotencyKey, "Idempotency-Key");
        if (request == null) {
            throw DomainException.badRequest("Request body is required",
                    java.util.Map.of("reason", "missing_body"));
        }
        BotMessageResult result = botMessageService.send(principal,
                new BotMessageCommand(request.chatId(), request.text(), key.toString()));
        ResponseEntity.BodyBuilder builder = ResponseEntity.status(201);
        if (result.replay()) {
            builder.header("Idempotent-Replay", "true");
        }
        return builder.body(MessageApiMapper.toResponse(result.message()));
    }

    private static BotPrincipal botPrincipal(Authentication authentication, UUID pathBotId) {
        if (authentication == null
                || !(authentication.getPrincipal() instanceof BotPrincipal principal)) {
            throw DomainException.unauthorized("UNAUTHENTICATED", "Bot authentication required",
                    java.util.Map.of());
        }
        // The filter already checks this; keeping it here makes the controller safe even if a
        // future chain change misroutes a token.
        if (!principal.botId().equals(pathBotId)) {
            throw DomainException.unauthorized("UNAUTHENTICATED", "Invalid bot token",
                    java.util.Map.of());
        }
        return principal;
    }
}
