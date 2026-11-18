package ru.krug.backend.message.application.command;

import java.util.UUID;

import ru.krug.backend.message.application.model.MessageCreateInput;
import ru.krug.backend.shared.application.model.Principal;

public record SendMessageCommand(
        Principal principal,
        UUID chatId,
        UUID idempotencyKey,
        MessageCreateInput input) {

    public static final String IDEMPOTENCY_SCOPE = "POST /chats/{chatId}/messages";

    public SendMessageCommand withPrincipal(Principal scoped) {
        return new SendMessageCommand(scoped, chatId, idempotencyKey, input);
    }
}
