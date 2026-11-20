package ru.krug.backend.workspace.api.mapper;

import java.util.List;

import ru.krug.backend.workspace.api.dto.CreateDlpPolicyRequest;
import ru.krug.backend.workspace.api.dto.DlpEventPageResponse;
import ru.krug.backend.workspace.api.dto.DlpEventResponse;
import ru.krug.backend.workspace.api.dto.DlpPolicyListResponse;
import ru.krug.backend.workspace.api.dto.DlpPolicyResponse;
import ru.krug.backend.workspace.api.dto.UpdateDlpPolicyRequest;
import ru.krug.backend.workspace.api.dto.UpdateWorkspaceSecurityRequest;
import ru.krug.backend.workspace.api.dto.WorkspaceAuditEventResponse;
import ru.krug.backend.workspace.api.dto.WorkspaceAuditExportResponse;
import ru.krug.backend.workspace.api.dto.WorkspaceAuditPageResponse;
import ru.krug.backend.workspace.api.dto.WorkspaceSecurityResponse;
import ru.krug.backend.workspace.api.dto.WorkspaceSessionPageResponse;
import ru.krug.backend.workspace.api.dto.WorkspaceSessionResponse;
import ru.krug.backend.workspace.api.dto.WorkspaceSessionRevokeAllResponse;
import ru.krug.backend.workspace.application.command.CreateDlpPolicyCommand;
import ru.krug.backend.workspace.application.command.UpdateDlpPolicyCommand;
import ru.krug.backend.workspace.application.command.UpdateWorkspaceSecurityCommand;
import ru.krug.backend.workspace.application.model.DlpEventPageView;
import ru.krug.backend.workspace.application.model.DlpEventView;
import ru.krug.backend.workspace.application.model.DlpPolicyView;
import ru.krug.backend.workspace.application.model.WorkspaceAuditExportView;
import ru.krug.backend.workspace.application.model.WorkspaceAuditPageView;
import ru.krug.backend.workspace.application.model.WorkspaceAuditView;
import ru.krug.backend.workspace.application.model.WorkspaceSecurityView;
import ru.krug.backend.workspace.application.model.WorkspaceSessionPageView;
import ru.krug.backend.workspace.application.model.WorkspaceSessionRevokeAllView;
import ru.krug.backend.workspace.application.model.WorkspaceSessionView;

/**
 * Application views -> workspace security API DTOs, plus the bounded RFC 4180 CSV
 * encoding used by the audit export. No domain/infrastructure type crosses this boundary.
 */
public final class WorkspaceSecurityApiMapper {

    private static final String CSV_HEADER =
            "created_at,action,actor_id,target_type,target_id\n";

    private WorkspaceSecurityApiMapper() {
    }

    public static DlpPolicyResponse toResponse(DlpPolicyView view) {
        return new DlpPolicyResponse(view.id(), view.name(), view.action(), view.patternType(),
                view.pattern(), view.enabled(), view.createdAt(), view.updatedAt());
    }

    public static DlpPolicyListResponse toResponse(List<DlpPolicyView> views) {
        return new DlpPolicyListResponse(views.stream()
                .map(WorkspaceSecurityApiMapper::toResponse).toList());
    }

    public static DlpEventPageResponse toPage(DlpEventPageView view) {
        return new DlpEventPageResponse(view.items().stream()
                .map(WorkspaceSecurityApiMapper::toResponse).toList(),
                view.nextCursor(), view.hasMore());
    }

    public static DlpEventResponse toResponse(DlpEventView view) {
        return new DlpEventResponse(view.id(), view.policyId(), view.policyName(),
                view.action(), view.actorId(), view.chatId(), view.createdAt());
    }

    public static WorkspaceAuditPageResponse toPage(WorkspaceAuditPageView view) {
        return new WorkspaceAuditPageResponse(view.items().stream()
                .map(WorkspaceSecurityApiMapper::toResponse).toList(),
                view.nextCursor(), view.hasMore());
    }

    public static WorkspaceAuditExportResponse toResponse(WorkspaceAuditExportView view) {
        return new WorkspaceAuditExportResponse(view.items().stream()
                .map(WorkspaceSecurityApiMapper::toResponse).toList(),
                view.exportedRows(), view.truncated());
    }

    public static WorkspaceAuditEventResponse toResponse(WorkspaceAuditView view) {
        return new WorkspaceAuditEventResponse(view.id(), view.action(), view.actorId(),
                view.targetType(), view.targetId(), view.createdAt());
    }

    public static WorkspaceSessionPageResponse toPage(WorkspaceSessionPageView view) {
        return new WorkspaceSessionPageResponse(view.items().stream()
                .map(WorkspaceSecurityApiMapper::toResponse).toList(),
                view.nextCursor(), view.hasMore());
    }

    public static WorkspaceSessionResponse toResponse(WorkspaceSessionView view) {
        return new WorkspaceSessionResponse(view.id(), view.userId(), view.device(),
                view.createdAt(), view.lastSeenAt(), view.current());
    }

    public static WorkspaceSessionRevokeAllResponse toResponse(
            WorkspaceSessionRevokeAllView view) {
        return new WorkspaceSessionRevokeAllResponse(view.revokedSessions(),
                view.affectedUsers());
    }

    public static WorkspaceSecurityResponse toResponse(WorkspaceSecurityView view) {
        return new WorkspaceSecurityResponse(view.requireTwoFactor(),
                view.sessionTimeoutMinutes(), view.dlpEnabled(), view.retentionDays(),
                view.updatedAt());
    }

    public static CreateDlpPolicyCommand toCommand(CreateDlpPolicyRequest request) {
        return new CreateDlpPolicyCommand(request.name(), request.action(),
                request.patternType(), request.pattern(), request.enabled());
    }

    public static UpdateDlpPolicyCommand toCommand(UpdateDlpPolicyRequest request) {
        return new UpdateDlpPolicyCommand(request.name(), request.action(),
                request.patternType(), request.pattern(), request.enabled());
    }

    public static UpdateWorkspaceSecurityCommand toCommand(
            UpdateWorkspaceSecurityRequest request) {
        return new UpdateWorkspaceSecurityCommand(request.requireTwoFactor(),
                request.sessionTimeoutMinutes(), request.dlpEnabled(),
                request.retentionDays(), request.securityMode());
    }

    /**
     * RFC 4180 CSV: a field is quoted only when it contains a comma, quote, CR or LF; an
     * embedded quote is doubled. Values written here are server-generated ids/actions and
     * ISO-8601 timestamps, never user-supplied text.
     */
    public static String toCsv(WorkspaceAuditExportView view) {
        StringBuilder csv = new StringBuilder(CSV_HEADER);
        for (WorkspaceAuditView item : view.items()) {
            csv.append(csvField(item.createdAt() == null ? null : item.createdAt().toString()))
                    .append(',')
                    .append(csvField(item.action()))
                    .append(',')
                    .append(csvField(item.actorId() == null ? null : item.actorId().toString()))
                    .append(',')
                    .append(csvField(item.targetType()))
                    .append(',')
                    .append(csvField(item.targetId() == null ? null
                            : item.targetId().toString()))
                    .append('\n');
        }
        return csv.toString();
    }

    private static String csvField(String value) {
        if (value == null || value.isEmpty()) {
            return "";
        }
        boolean quote = value.indexOf(',') >= 0 || value.indexOf('"') >= 0
                || value.indexOf('\n') >= 0 || value.indexOf('\r') >= 0;
        if (!quote) {
            return value;
        }
        return '"' + value.replace("\"", "\"\"") + '"';
    }
}
