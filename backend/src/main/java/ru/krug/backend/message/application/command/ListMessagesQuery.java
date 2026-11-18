package ru.krug.backend.message.application.command;

import java.util.UUID;

import ru.krug.backend.shared.application.model.Principal;

public record ListMessagesQuery(
        Principal principal,
        UUID chatId,
        Long afterSeq,
        Long beforeSeq,
        Integer limit) {
}
