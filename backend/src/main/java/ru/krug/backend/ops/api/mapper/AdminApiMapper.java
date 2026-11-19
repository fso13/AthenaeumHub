package ru.krug.backend.ops.api.mapper;

import ru.krug.backend.ops.api.dto.AdminAuditEventResponse;
import ru.krug.backend.ops.api.dto.AdminAuditPageResponse;
import ru.krug.backend.ops.api.dto.AdminChatPageResponse;
import ru.krug.backend.ops.api.dto.AdminChatResponse;
import ru.krug.backend.ops.api.dto.AdminOverviewResponse;
import ru.krug.backend.ops.api.dto.AdminSettingsPatchRequest;
import ru.krug.backend.ops.api.dto.AdminSettingsResponse;
import ru.krug.backend.ops.api.dto.AdminStorageResponse;
import ru.krug.backend.ops.api.dto.AdminStorageTotalsResponse;
import ru.krug.backend.ops.api.dto.AdminStorageWorkspaceResponse;
import ru.krug.backend.ops.api.dto.AdminUserPageResponse;
import ru.krug.backend.ops.api.dto.AdminUserResponse;
import ru.krug.backend.ops.api.dto.SetupStatusResponse;
import ru.krug.backend.ops.api.dto.TestEmailResponse;
import ru.krug.backend.ops.application.model.AdminAuditPageView;
import ru.krug.backend.ops.application.model.AdminAuditView;
import ru.krug.backend.ops.application.model.AdminChatPageView;
import ru.krug.backend.ops.application.model.AdminChatView;
import ru.krug.backend.ops.application.model.AdminOverviewView;
import ru.krug.backend.ops.application.model.AdminStorageView;
import ru.krug.backend.ops.application.model.AdminStorageWorkspaceView;
import ru.krug.backend.ops.application.model.AdminUserPageView;
import ru.krug.backend.ops.application.model.AdminUserView;
import ru.krug.backend.ops.application.model.SetupStatusView;
import ru.krug.backend.ops.application.model.SystemSettingsUpdateCommand;
import ru.krug.backend.ops.application.model.SystemSettingsView;

/** Application read models -> admin API DTOs. No domain/infrastructure types cross here. */
public final class AdminApiMapper {

    private AdminApiMapper() {
    }

    public static SetupStatusResponse toResponse(SetupStatusView view) {
        return new SetupStatusResponse(view.setupRequired(), view.registrationOpen());
    }

    public static AdminSettingsResponse toResponse(SystemSettingsView view) {
        return new AdminSettingsResponse(view.setupCompleted(), view.setupCompletedAt(),
                view.smtp().host(), view.smtp().port(), view.smtp().username(),
                view.smtp().from(), view.smtp().starttls(), view.smtp().configured(),
                view.allowedFileExtensions(), view.maxChatsPerUser(),
                view.maxChatsPerWorkspace(), view.maxWorkspaceMembers(),
                view.registrationOpen(), view.updatedAt(), view.updatedBy());
    }

    public static AdminOverviewResponse toResponse(AdminOverviewView view) {
        return new AdminOverviewResponse(view.users(), view.workspaces(), view.chats());
    }

    public static AdminUserResponse toResponse(AdminUserView view) {
        return new AdminUserResponse(view.id(), view.email(), view.displayName(),
                view.platformAdmin(), view.status(), view.workspacesCount(), view.chatsCount(),
                view.storageUsedBytes(), view.createdAt());
    }

    public static AdminUserPageResponse toPage(AdminUserPageView view) {
        return new AdminUserPageResponse(view.items().stream()
                .map(AdminApiMapper::toResponse).toList(), view.nextCursor(), view.hasMore());
    }

    public static AdminChatResponse toResponse(AdminChatView view) {
        return new AdminChatResponse(view.id(), view.name(), view.type(), view.securityMode(),
                view.workspaceId(), view.workspaceName(), view.membersCount(),
                view.messagesCount(), view.createdAt(), view.lastActivityAt());
    }

    public static AdminChatPageResponse toPage(AdminChatPageView view) {
        return new AdminChatPageResponse(view.items().stream()
                .map(AdminApiMapper::toResponse).toList(), view.nextCursor(), view.hasMore());
    }

    public static AdminAuditEventResponse toResponse(AdminAuditView view) {
        return new AdminAuditEventResponse(view.id(), view.action(), view.actorId(),
                view.actorEmail(), view.targetType(), view.targetId(), view.createdAt());
    }

    public static AdminAuditPageResponse toPage(AdminAuditPageView view) {
        return new AdminAuditPageResponse(view.items().stream()
                .map(AdminApiMapper::toResponse).toList(), view.nextCursor(), view.hasMore());
    }

    public static AdminStorageResponse toResponse(AdminStorageView view) {
        return new AdminStorageResponse(
                new AdminStorageTotalsResponse(view.totals().usedBytes(),
                        view.totals().reservedBytes(), view.totals().objects(),
                        view.totals().attachments()),
                view.workspaces().stream().map(AdminApiMapper::toResponse).toList());
    }

    public static AdminStorageWorkspaceResponse toResponse(AdminStorageWorkspaceView view) {
        return new AdminStorageWorkspaceResponse(view.workspaceId(), view.workspaceName(),
                view.securityMode(), view.usedBytes(), view.reservedBytes(),
                view.storageLimitBytes(), view.objects(), view.attachments());
    }

    public static TestEmailResponse toResponse(String to) {
        return new TestEmailResponse(true, to);
    }

    public static SystemSettingsUpdateCommand toCommand(AdminSettingsPatchRequest request) {
        return new SystemSettingsUpdateCommand(request.smtpHost(), request.smtpPort(),
                request.smtpUsername(), request.smtpPassword(), request.smtpFrom(),
                request.smtpStarttls(), request.allowedFileExtensions(),
                request.maxChatsPerUser(), request.maxChatsPerWorkspace(),
                request.maxWorkspaceMembers(), request.registrationOpen(),
                request.completeSetup(), request.setupCompleted());
    }
}
