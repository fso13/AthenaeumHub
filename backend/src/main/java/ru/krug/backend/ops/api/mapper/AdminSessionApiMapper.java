package ru.krug.backend.ops.api.mapper;

import ru.krug.backend.ops.api.dto.AdminSessionPageResponse;
import ru.krug.backend.ops.api.dto.AdminSessionResponse;
import ru.krug.backend.ops.api.dto.AdminSessionRevokeAllResponse;
import ru.krug.backend.ops.application.model.AdminSessionPageView;
import ru.krug.backend.ops.application.model.AdminSessionRevokeAllView;
import ru.krug.backend.ops.application.model.AdminSessionView;

/** Platform-admin session read models -> API DTOs. */
public final class AdminSessionApiMapper {

    private AdminSessionApiMapper() {
    }

    public static AdminSessionResponse toResponse(AdminSessionView view) {
        return new AdminSessionResponse(view.id(), view.userId(), view.device(),
                view.createdAt(), view.lastSeenAt(), view.current());
    }

    public static AdminSessionPageResponse toPage(AdminSessionPageView view) {
        return new AdminSessionPageResponse(view.items().stream()
                .map(AdminSessionApiMapper::toResponse).toList(), view.nextCursor(),
                view.hasMore());
    }

    public static AdminSessionRevokeAllResponse toResponse(AdminSessionRevokeAllView view) {
        return new AdminSessionRevokeAllResponse(view.revokedSessions(), view.affectedUsers());
    }
}
