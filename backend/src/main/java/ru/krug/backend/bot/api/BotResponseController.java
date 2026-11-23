package ru.krug.backend.bot.api;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import ru.krug.backend.bot.api.dto.BotResponseCreateRequest;
import ru.krug.backend.bot.application.usecase.BotResponseService;
import ru.krug.backend.message.api.dto.MessageResponse;
import ru.krug.backend.message.api.mapper.MessageApiMapper;
import ru.krug.backend.shared.api.RequestIdFilter;
import ru.krug.backend.shared.error.DomainException;

import jakarta.servlet.http.HttpServletRequest;

/**
 * {@code POST /bot-responses/{token}}: the one-time response capability delivered to a bot in
 * {@code response_url}. The token itself authorises exactly one bot message; no user JWT or
 * bot bearer is required. The path token is a secret and is never logged.
 */
@RestController
@RequestMapping("/api/v1/bot-responses")
public class BotResponseController {

    private final BotResponseService responses;

    public BotResponseController(BotResponseService responses) {
        this.responses = responses;
    }

    @PostMapping("/{token}")
    public ResponseEntity<MessageResponse> respond(@PathVariable String token,
                                                   @RequestBody(required = false)
                                                   BotResponseCreateRequest request,
                                                   HttpServletRequest httpRequest) {
        if (request == null) {
            throw DomainException.badRequest("Request body is required",
                    java.util.Map.of("reason", "missing_body"));
        }
        var message = responses.respond(token, request.text(),
                RequestIdFilter.requestId(httpRequest));
        return ResponseEntity.status(201).body(MessageApiMapper.toResponse(message));
    }
}
