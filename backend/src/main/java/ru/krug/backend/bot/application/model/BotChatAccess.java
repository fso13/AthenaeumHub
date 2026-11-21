package ru.krug.backend.bot.application.model;

import java.util.UUID;

/** Chat-scoped authorisation result for installation/list endpoints. */
public record BotChatAccess(UUID workspaceId, String securityMode, String memberRole) {

    public boolean canManage() {
        return "OWNER".equals(memberRole) || "ADMIN".equals(memberRole);
    }
}
