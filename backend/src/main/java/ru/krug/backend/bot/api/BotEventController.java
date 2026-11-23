package ru.krug.backend.bot.api;

import java.util.UUID;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import ru.krug.backend.bot.api.dto.BotDeliveryAcceptedResponse;
import ru.krug.backend.bot.api.dto.BotDeliveryListResponse;
import ru.krug.backend.bot.api.dto.BotSigningSecretResponse;
import ru.krug.backend.bot.api.mapper.BotApiMapper;
import ru.krug.backend.bot.application.usecase.ListBotDeliveriesService;
import ru.krug.backend.bot.application.usecase.RotateBotSecretService;
import ru.krug.backend.bot.application.usecase.TestBotEventService;
import ru.krug.backend.shared.application.model.Principal;

/**
 * Bot event administration (OWNER/ADMIN):
 *
 * <pre>
 * POST /workspaces/{workspaceId}/bots/{botId}/secret      — generate/rotate, reveal once
 * GET  /workspaces/{workspaceId}/bots/{botId}/deliveries  — recent content-free statuses
 * POST /workspaces/{workspaceId}/bots/{botId}/test-event  — queue a signed ping (202)
 * </pre>
 */
@RestController
@RequestMapping("/api/v1/workspaces/{workspaceId}/bots/{botId}")
public class BotEventController {

    private final RotateBotSecretService rotateSecret;
    private final ListBotDeliveriesService listDeliveries;
    private final TestBotEventService testEvent;

    public BotEventController(RotateBotSecretService rotateSecret,
                              ListBotDeliveriesService listDeliveries,
                              TestBotEventService testEvent) {
        this.rotateSecret = rotateSecret;
        this.listDeliveries = listDeliveries;
        this.testEvent = testEvent;
    }

    @PostMapping("/secret")
    public BotSigningSecretResponse rotateSecret(@PathVariable UUID workspaceId,
                                                 @PathVariable UUID botId,
                                                 Principal principal) {
        return BotApiMapper.toSigningSecretResponse(
                rotateSecret.rotate(principal, workspaceId, botId));
    }

    @GetMapping("/deliveries")
    public BotDeliveryListResponse deliveries(@PathVariable UUID workspaceId,
                                              @PathVariable UUID botId,
                                              @RequestParam(name = "limit",
                                                      defaultValue = "50") int limit,
                                              Principal principal) {
        return BotApiMapper.toDeliveryListResponse(
                listDeliveries.list(principal, workspaceId, botId, limit));
    }

    @PostMapping("/test-event")
    public ResponseEntity<BotDeliveryAcceptedResponse> testEvent(
            @PathVariable UUID workspaceId, @PathVariable UUID botId, Principal principal) {
        UUID deliveryId = testEvent.queue(principal, workspaceId, botId);
        return ResponseEntity.status(202)
                .body(new BotDeliveryAcceptedResponse(deliveryId));
    }
}
