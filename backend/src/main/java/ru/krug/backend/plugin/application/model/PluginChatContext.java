package ru.krug.backend.plugin.application.model;

import java.util.UUID;

import ru.krug.backend.plugin.domain.model.PluginMode;

/**
 * Plugin-side authorisation result: the chat's workspace, immutable security mode and the
 * caller's ACTIVE chat role. Manager rights are intentionally chat-scoped in this slice —
 * {@code GET} requires membership, {@code PATCH} requires chat {@code OWNER}/{@code ADMIN}.
 */
public record PluginChatContext(UUID workspaceId, String securityMode, String memberRole) {

    public PluginMode mode() {
        return PluginMode.valueOf(securityMode);
    }

    public boolean canManage() {
        return "OWNER".equals(memberRole) || "ADMIN".equals(memberRole);
    }
}
