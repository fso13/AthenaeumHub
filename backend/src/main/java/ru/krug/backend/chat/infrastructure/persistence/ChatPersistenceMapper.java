package ru.krug.backend.chat.infrastructure.persistence;

import ru.krug.backend.chat.domain.model.Chat;

public final class ChatPersistenceMapper {

    private ChatPersistenceMapper() {
    }

    public static Chat toDomain(ChatEntity entity) {
        return Chat.reconstitute(entity.getId(), entity.getWorkspaceId(),
                Chat.Type.valueOf(entity.getType()),
                Chat.SecurityMode.valueOf(entity.getSecurityMode()),
                entity.getName(), entity.getDescription(), entity.getCreatedBy(),
                entity.getLastMessageAt(), entity.getCreatedAt());
    }
}
