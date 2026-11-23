package ru.krug.backend.bot.api.mapper;

import java.util.List;

import ru.krug.backend.bot.api.dto.BotCommandResponse;
import ru.krug.backend.bot.api.dto.BotDeliveryListResponse;
import ru.krug.backend.bot.api.dto.BotDeliveryResponse;
import ru.krug.backend.bot.api.dto.BotListResponse;
import ru.krug.backend.bot.api.dto.BotResponse;
import ru.krug.backend.bot.api.dto.BotSigningSecretResponse;
import ru.krug.backend.bot.api.dto.BotTokenResponse;
import ru.krug.backend.bot.api.dto.ChatBotListResponse;
import ru.krug.backend.bot.api.dto.ChatBotResponse;
import ru.krug.backend.bot.application.model.BotDeliveryView;
import ru.krug.backend.bot.application.model.BotUpdateResult;
import ru.krug.backend.bot.application.model.BotView;
import ru.krug.backend.bot.application.model.ChatBotView;
import ru.krug.backend.bot.application.model.IssuedBotToken;

/** Application view -> API DTO. No raw token/secret is added outside create/rotate. */
public final class BotApiMapper {

    private BotApiMapper() {
    }

    public static BotResponse toResponse(BotView view) {
        return new BotResponse(view.id(), view.workspaceId(), view.name(), view.avatarFileId(),
                view.scopes(), view.status(), view.createdBy(), view.createdAt(),
                view.updatedAt(), view.tokenRotatedAt(), view.eventsUrl(), view.events(),
                view.eventsEnabled(), view.hasSigningSecret(), view.signingSecretCreatedAt(),
                view.commands().stream()
                        .map(item -> new BotCommandResponse(item.command(),
                                item.description()))
                        .toList(),
                view.signingSecret());
    }

    public static BotTokenResponse toTokenResponse(IssuedBotToken issued) {
        return new BotTokenResponse(toResponse(issued.bot()), issued.token());
    }

    public static BotSigningSecretResponse toSigningSecretResponse(BotUpdateResult result) {
        return new BotSigningSecretResponse(toResponse(result.bot().withoutSecret()),
                result.signingSecret());
    }

    public static BotListResponse toListResponse(List<BotView> views) {
        return new BotListResponse(views.stream().map(BotApiMapper::toResponse).toList());
    }

    public static BotDeliveryResponse toResponse(BotDeliveryView view) {
        return new BotDeliveryResponse(view.id(), view.eventType(), view.eventId(),
                view.chatId(), view.status(), view.attemptCount(), view.nextAttemptAt(),
                view.lastStatusCode(), view.lastError(), view.createdAt(), view.updatedAt(),
                view.deliveredAt());
    }

    public static BotDeliveryListResponse toDeliveryListResponse(List<BotDeliveryView> views) {
        return new BotDeliveryListResponse(
                views.stream().map(BotApiMapper::toResponse).toList());
    }

    public static ChatBotResponse toResponse(ChatBotView view) {
        return new ChatBotResponse(view.chatId(), toResponse(view.bot()), view.enabled(),
                view.installedAt());
    }

    public static ChatBotListResponse toChatListResponse(List<ChatBotView> views) {
        return new ChatBotListResponse(views.stream().map(BotApiMapper::toResponse).toList());
    }
}
