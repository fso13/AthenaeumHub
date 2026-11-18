package ru.krug.backend.chat.domain.model;

import java.util.UUID;

/**
 * D1-BE3 authorization scope for {@code PATCH /chats/{chatId}}, resolved by the V30
 * {@code chat.settings_scope} function. The endpoint has no workspace in its URL, so the
 * scope is looked up from the chat while the caller's user GUC is active.
 *
 * <p>The lookup intentionally does not require chat membership: settings are guarded by
 * workspace roles (OWNER/ADMIN), matching {@code docs/TASKS-DASHBOARD-V1.md} §3.4.</p>
 *
 * @param workspaceId  workspace that owns the live chat
 * @param workspaceRole ACTIVE workspace role of the caller (OWNER/ADMIN/MEMBER/GUEST)
 */
public record ChatSettingsScope(UUID workspaceId, String workspaceRole) {

    public boolean canManage() {
        return "OWNER".equals(workspaceRole) || "ADMIN".equals(workspaceRole);
    }
}
