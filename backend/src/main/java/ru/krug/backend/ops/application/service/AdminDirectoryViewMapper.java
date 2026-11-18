package ru.krug.backend.ops.application.service;

import ru.krug.backend.ops.application.model.AdminChatView;
import ru.krug.backend.ops.application.model.AdminStorageWorkspaceView;
import ru.krug.backend.ops.application.model.AdminUserView;
import ru.krug.backend.ops.domain.model.AdminChatRow;
import ru.krug.backend.ops.domain.model.AdminStorageWorkspaceRow;
import ru.krug.backend.ops.domain.model.AdminUserRow;

/** Domain rows -> application read models for the admin directory. No transport types. */
public final class AdminDirectoryViewMapper {

    private AdminDirectoryViewMapper() {
    }

    public static AdminUserView toView(AdminUserRow row) {
        return new AdminUserView(row.id(), row.email(), row.displayName(), row.platformAdmin(),
                row.status(), row.workspacesCount(), row.chatsCount(), row.storageUsedBytes(),
                row.createdAt());
    }

    public static AdminChatView toView(AdminChatRow row) {
        return new AdminChatView(row.id(), row.name(), row.type(), row.securityMode(),
                row.workspaceId(), row.workspaceName(), row.membersCount(), row.messagesCount(),
                row.createdAt(), row.lastActivityAt());
    }

    public static AdminStorageWorkspaceView toView(AdminStorageWorkspaceRow row) {
        return new AdminStorageWorkspaceView(row.workspaceId(), row.workspaceName(),
                row.securityMode(), row.usedBytes(), row.reservedBytes(),
                row.storageLimitBytes(), row.objects(), row.attachments());
    }
}
