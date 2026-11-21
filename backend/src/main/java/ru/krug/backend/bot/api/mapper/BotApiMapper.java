package ru.krug.backend.bot.api.mapper;

import java.util.List;

import ru.krug.backend.bot.api.dto.BotListResponse;
import ru.krug.backend.bot.api.dto.BotResponse;
import ru.krug.backend.bot.api.dto.BotTokenResponse;
import ru.krug.backend.bot.api.dto.ChatBotListResponse;
import ru.krug.backend.bot.api.dto.ChatBotResponse;
import ru.krug.backend.bot.application.model.BotView;
import ru.krug.backend.bot.application.model.ChatBotView;
import ru.krug.backend.bot.application.model.IssuedBotToken;

/** Application view -> API DTO. No raw token is added outside create/rotate. */
public final class BotApiMapper {

    private BotApiMapper() {
    }

    public static BotResponse toResponse(BotView view) {
        return new BotResponse(view.id(), view.workspaceId(), view.name(), view.avatarFileId(),
                view.scopes(), view.status(), view.createdBy(), view.createdAt(),
                view.updatedAt(), view.tokenRotatedAt());
    }

    public static BotTokenResponse toTokenResponse(IssuedBotToken issued) {
        return new BotTokenResponse(toResponse(issued.bot()), issued.token());
    }

    public static BotListResponse toListResponse(List<BotView> views) {
        return new BotListResponse(views.stream().map(BotApiMapper::toResponse).toList());
    }

    public static ChatBotResponse toResponse(ChatBotView view) {
        return new ChatBotResponse(view.chatId(), toResponse(view.bot()), view.enabled(),
                view.installedAt());
    }

    public static ChatBotListResponse toChatListResponse(List<ChatBotView> views) {
        return new ChatBotListResponse(views.stream().map(BotApiMapper::toResponse).toList());
    }
}
