package ru.krug.backend.chat.application.model;

import java.util.UUID;

import ru.krug.backend.chat.domain.model.Chat;
import ru.krug.backend.chat.domain.model.ChatMember;

/**
 * Resolved chat-membership scope for an authenticated caller: the owning workspace, the
 * caller's ACTIVE workspace role (resolved by {@code chat.settings_scope}), the live chat and
 * the caller's participant row (null when the caller is an ACTIVE workspace member who never
 * joined this channel).
 */
public record ChatMembershipContext(UUID workspaceId, String workspaceRole, Chat chat,
                                    ChatMember member) {

    public boolean workspaceManager() {
        return "OWNER".equals(workspaceRole) || "ADMIN".equals(workspaceRole);
    }
}
