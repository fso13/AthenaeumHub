package ru.krug.backend.chat.application.model;

import java.util.UUID;

/**
 * Application-level authorisation result. Not a domain entity and not an API DTO.
 */
public record ChatAccess(UUID chatId, UUID workspaceId, String chatType, String memberRole,
                         String securityMode, long lastSeq) {
}
