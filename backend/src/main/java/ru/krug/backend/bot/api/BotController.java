package ru.krug.backend.bot.api;

import java.util.Map;
import java.util.UUID;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import ru.krug.backend.bot.api.dto.BotCreateRequest;
import ru.krug.backend.bot.api.dto.BotListResponse;
import ru.krug.backend.bot.api.dto.BotResponse;
import ru.krug.backend.bot.api.dto.BotTokenResponse;
import ru.krug.backend.bot.api.dto.BotUpdateRequest;
import ru.krug.backend.bot.api.dto.ChatBotInstallRequest;
import ru.krug.backend.bot.api.dto.ChatBotListResponse;
import ru.krug.backend.bot.api.dto.ChatBotResponse;
import ru.krug.backend.bot.api.mapper.BotApiMapper;
import ru.krug.backend.bot.application.command.CreateBotCommand;
import ru.krug.backend.bot.application.command.UpdateBotCommand;
import ru.krug.backend.bot.application.model.ChatBotView;
import ru.krug.backend.bot.application.usecase.CreateBotService;
import ru.krug.backend.bot.application.usecase.DisableBotService;
import ru.krug.backend.bot.application.usecase.InstallBotService;
import ru.krug.backend.bot.application.usecase.ListBotsService;
import ru.krug.backend.bot.application.usecase.ListChatBotsService;
import ru.krug.backend.bot.application.usecase.RotateBotTokenService;
import ru.krug.backend.bot.application.usecase.UninstallBotService;
import ru.krug.backend.bot.application.usecase.UpdateBotService;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.error.DomainException;

/**
 * Bot management (JWT endpoints, not the bot-token API):
 *
 * <pre>
 * POST   /workspaces/{workspaceId}/bots              — create + one-time token (OWNER/ADMIN)
 * GET    /workspaces/{workspaceId}/bots              — list (any ACTIVE member)
 * PATCH  /workspaces/{workspaceId}/bots/{botId}      — name/scopes/status/avatar (OWNER/ADMIN)
 * DELETE /workspaces/{workspaceId}/bots/{botId}      — disable (OWNER/ADMIN)
 * POST   /workspaces/{workspaceId}/bots/{botId}/token — rotate token (OWNER/ADMIN)
 * GET    /chats/{chatId}/bots                        — installed bots (chat member)
 * POST   /chats/{chatId}/bots                        — install (chat OWNER/ADMIN)
 * DELETE /chats/{chatId}/bots/{botId}                — uninstall (chat OWNER/ADMIN)
 * </pre>
 *
 * <p>No response except create/rotate contains a token. The controller stays thin;
 * authorization, validation, audit and error codes live in the application layer.</p>
 */
@RestController
@RequestMapping("/api/v1")
public class BotController {

    private final CreateBotService createBot;
    private final ListBotsService listBots;
    private final UpdateBotService updateBot;
    private final DisableBotService disableBot;
    private final RotateBotTokenService rotateToken;
    private final InstallBotService installBot;
    private final UninstallBotService uninstallBot;
    private final ListChatBotsService listChatBots;

    public BotController(CreateBotService createBot, ListBotsService listBots,
                         UpdateBotService updateBot, DisableBotService disableBot,
                         RotateBotTokenService rotateToken, InstallBotService installBot,
                         UninstallBotService uninstallBot, ListChatBotsService listChatBots) {
        this.createBot = createBot;
        this.listBots = listBots;
        this.updateBot = updateBot;
        this.disableBot = disableBot;
        this.rotateToken = rotateToken;
        this.installBot = installBot;
        this.uninstallBot = uninstallBot;
        this.listChatBots = listChatBots;
    }

    @PostMapping("/workspaces/{workspaceId}/bots")
    public ResponseEntity<BotTokenResponse> create(@PathVariable UUID workspaceId,
                                                   @RequestBody(required = false)
                                                   BotCreateRequest request,
                                                   Principal principal) {
        if (request == null) {
            throw DomainException.badRequest("Request body is required",
                    Map.of("reason", "missing_body"));
        }
        var issued = createBot.create(principal, workspaceId,
                new CreateBotCommand(request.name(), request.scopes()));
        return ResponseEntity.status(201).body(BotApiMapper.toTokenResponse(issued));
    }

    @GetMapping("/workspaces/{workspaceId}/bots")
    public BotListResponse list(@PathVariable UUID workspaceId, Principal principal) {
        return BotApiMapper.toListResponse(listBots.list(principal, workspaceId));
    }

    @PatchMapping("/workspaces/{workspaceId}/bots/{botId}")
    public BotResponse update(@PathVariable UUID workspaceId, @PathVariable UUID botId,
                              @RequestBody(required = false) BotUpdateRequest request,
                              Principal principal) {
        if (request == null) {
            throw DomainException.badRequest("Request body is required",
                    Map.of("reason", "missing_body"));
        }
        return BotApiMapper.toResponse(updateBot.update(principal, workspaceId, botId,
                new UpdateBotCommand(request.name(), request.scopes(), request.avatarFileId(),
                        Boolean.TRUE.equals(request.clearAvatar()), request.status(),
                        request.eventsUrl(), request.events(),
                        request.eventsEnabled() != null
                                ? request.eventsEnabled() : request.enabled(),
                        toCommandInputs(request.commands()))).bot());
    }

    @DeleteMapping("/workspaces/{workspaceId}/bots/{botId}")
    public ResponseEntity<Void> disable(@PathVariable UUID workspaceId,
                                        @PathVariable UUID botId, Principal principal) {
        disableBot.disable(principal, workspaceId, botId);
        return ResponseEntity.noContent().build();
    }

    @PostMapping("/workspaces/{workspaceId}/bots/{botId}/token")
    public BotTokenResponse rotateToken(@PathVariable UUID workspaceId,
                                        @PathVariable UUID botId, Principal principal) {
        return BotApiMapper.toTokenResponse(rotateToken.rotate(principal, workspaceId, botId));
    }

    @GetMapping("/chats/{chatId}/bots")
    public ChatBotListResponse listChatBots(@PathVariable UUID chatId, Principal principal) {
        return BotApiMapper.toChatListResponse(listChatBots.list(principal, chatId));
    }

    @PostMapping("/chats/{chatId}/bots")
    public ResponseEntity<ChatBotResponse> install(@PathVariable UUID chatId,
                                                   @RequestBody(required = false)
                                                   ChatBotInstallRequest request,
                                                   Principal principal) {
        if (request == null || request.botId() == null) {
            throw DomainException.badRequest("bot_id is required",
                    Map.of("field", "bot_id"));
        }
        ChatBotView view = installBot.install(principal, chatId, request.botId());
        return ResponseEntity.status(201).body(BotApiMapper.toResponse(view));
    }

    private static java.util.List<ru.krug.backend.bot.application.command.BotCommandInput>
            toCommandInputs(java.util.List<ru.krug.backend.bot.api.dto.BotCommandRequest> items) {
        if (items == null) {
            return null;
        }
        return items.stream()
                .map(item -> item == null ? null
                        : new ru.krug.backend.bot.application.command.BotCommandInput(
                                item.command(), item.description()))
                .toList();
    }

    @DeleteMapping("/chats/{chatId}/bots/{botId}")
    public ResponseEntity<Void> uninstall(@PathVariable UUID chatId, @PathVariable UUID botId,
                                          Principal principal) {
        uninstallBot.uninstall(principal, chatId, botId);
        return ResponseEntity.noContent().build();
    }
}
