package ru.krug.backend.file.application.usecase;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.chat.application.port.ChatAccessPort;
import ru.krug.backend.chat.application.port.ChatWorkspacePort;
import ru.krug.backend.file.application.command.ListFilesQuery;
import ru.krug.backend.file.application.model.FileCenterRow;
import ru.krug.backend.file.application.model.FileItemView;
import ru.krug.backend.file.application.model.FileMediaView;
import ru.krug.backend.file.application.model.FilePageCursor;
import ru.krug.backend.file.application.model.FilePageView;
import ru.krug.backend.file.application.model.FileQuotaSummaryView;
import ru.krug.backend.file.application.port.FileCenterQueryPort;
import ru.krug.backend.file.application.port.FileCenterQueryPort.FileCenterQuery;
import ru.krug.backend.file.application.service.FileCenterRequests;
import ru.krug.backend.file.domain.model.MediaMetadata;
import ru.krug.backend.file.domain.model.QuotaUsage;
import ru.krug.backend.file.domain.model.WorkspaceLimits;
import ru.krug.backend.file.domain.repository.WorkspaceQuotaRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.TenantContext;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.workspace.application.port.WorkspaceAccessPort;

/**
 * {@code GET /files} — file center independent of the loaded message history (#73).
 *
 * <p>Access: the caller must be an ACTIVE member of the workspace; every listed item also
 * requires an ACTIVE membership in its chat, so a workspace member cannot enumerate files
 * of a chat they were never added to. A foreign/unknown workspace is 403, a foreign chat is
 * 404 (existence is not disclosed). E2EE chats and E2EE messages are excluded in SQL.
 *
 * <p>The query returns metadata only: no object key, hash, content or presigned URL. Quota
 * is a read-only snapshot; unlike the upload paths it never locks {@code workspace_usage}.
 */
@Service
public class ListFilesService {

    private final TenantContext tenantContext;
    private final WorkspaceAccessPort workspaceAccess;
    private final ChatAccessPort chatAccess;
    private final ChatWorkspacePort chatWorkspace;
    private final FileCenterQueryPort queryPort;
    private final WorkspaceQuotaRepository quotaRepository;

    public ListFilesService(TenantContext tenantContext, WorkspaceAccessPort workspaceAccess,
                            ChatAccessPort chatAccess, ChatWorkspacePort chatWorkspace,
                            FileCenterQueryPort queryPort,
                            WorkspaceQuotaRepository quotaRepository) {
        this.tenantContext = tenantContext;
        this.workspaceAccess = workspaceAccess;
        this.chatAccess = chatAccess;
        this.chatWorkspace = chatWorkspace;
        this.queryPort = queryPort;
        this.quotaRepository = quotaRepository;
    }

    @Transactional(readOnly = true)
    public FilePageView list(ListFilesQuery request) {
        Principal principal = request.principal();
        UUID workspaceId = resolveWorkspace(principal, request);
        Principal scoped = principal.withWorkspace(workspaceId);
        tenantContext.activate(scoped);
        workspaceAccess.requireActiveMember(workspaceId, scoped.userId());
        if (request.chatId() != null) {
            chatAccess.requireActiveChat(workspaceId, request.chatId(), scoped.userId());
        }

        int limit = FileCenterRequests.limit(request.limit());
        String kind = FileCenterRequests.kind(request.kind());
        String scanStatus = FileCenterRequests.scanStatus(request.scanStatus());
        String search = FileCenterRequests.query(request.query());
        String mime = FileCenterRequests.mime(request.mime());
        String extension = FileCenterRequests.extension(request.extension());
        FilePageCursor cursor = FileCenterRequests.cursor(request.cursor(), workspaceId);

        List<FileCenterRow> rows = queryPort.findPage(new FileCenterQuery(workspaceId,
                scoped.userId(), request.chatId(), kind, scanStatus, search, mime, extension,
                cursor == null ? null : cursor.createdAt(),
                cursor == null ? null : cursor.id(), limit + 1));

        boolean hasMore = rows.size() > limit;
        List<FileCenterRow> page = hasMore ? rows.subList(0, limit) : rows;
        String nextCursor = null;
        if (hasMore && !page.isEmpty()) {
            FileCenterRow last = page.get(page.size() - 1);
            nextCursor = new FilePageCursor(workspaceId, last.createdAt(), last.id()).encode();
        }
        List<FileItemView> items = page.stream()
                .map(ListFilesService::toView)
                .toList();
        return new FilePageView(items, nextCursor, hasMore, quota(workspaceId));
    }

    private UUID resolveWorkspace(Principal principal, ListFilesQuery request) {
        if (request.workspaceId() != null) {
            return request.workspaceId();
        }
        if (request.chatId() != null) {
            if (principal.workspaceId() != null) {
                // The path-less request is still scoped by the token's workspace claim;
                // requireActiveChat below rejects a chat from another workspace with 404.
                return principal.workspaceId();
            }
            return chatWorkspace.workspaceForChat(request.chatId(), principal.userId(),
                    principal.requestId());
        }
        if (principal.workspaceId() != null) {
            return principal.workspaceId();
        }
        throw DomainException.badRequest(
                "workspace_id is required when the token has no workspace claim",
                Map.of("field", "workspace_id", "reason", "required"));
    }

    private FileQuotaSummaryView quota(UUID workspaceId) {
        WorkspaceLimits limits = quotaRepository.findLimits(workspaceId)
                .orElseGet(() -> WorkspaceLimits.defaults(workspaceId));
        QuotaUsage usage = quotaRepository.findUsage(workspaceId).orElseGet(QuotaUsage::empty);
        long storage = limits.storageBytes();
        int percent = 0;
        if (storage > 0) {
            percent = usage.total() >= storage ? 100
                    : (int) ((usage.total() * 100) / storage);
        }
        return new FileQuotaSummaryView(usage.used(), usage.reserved(), storage, percent);
    }

    private static FileItemView toView(FileCenterRow row) {
        return new FileItemView(row.id(), row.filename(), row.sizeBytes(), row.mimeType(),
                row.scanStatus(), media(row.media()), row.chatId(), row.chatName(),
                row.messageId(), row.createdAt());
    }

    private static FileMediaView media(MediaMetadata media) {
        if (media == null) {
            return null;
        }
        return new FileMediaView(media.kind().name(), media.durationMs(), media.width(),
                media.height(), media.title(), media.artist(), media.album(), media.year(),
                media.genre(), media.artworkUrl(), media.metadataSource().name());
    }
}
