package ru.krug.backend.file.api.mapper;

import ru.krug.backend.file.api.dto.DownloadUrlResponse;
import ru.krug.backend.file.api.dto.FileItemResponse;
import ru.krug.backend.file.api.dto.FileMediaResponse;
import ru.krug.backend.file.api.dto.FilePageResponse;
import ru.krug.backend.file.api.dto.FileQuotaSummaryResponse;
import ru.krug.backend.file.api.dto.MediaMetadataRequest;
import ru.krug.backend.file.api.dto.PreflightDecisionResponse;
import ru.krug.backend.file.api.dto.PreflightQuotaResponse;
import ru.krug.backend.file.api.dto.PreflightResponse;
import ru.krug.backend.file.api.dto.UploadPartResponse;
import ru.krug.backend.file.api.dto.UploadSessionResponse;
import ru.krug.backend.file.api.dto.WorkspaceLimitsResponse;
import ru.krug.backend.file.api.dto.WorkspaceUsageResponse;
import ru.krug.backend.file.application.model.DownloadUrlView;
import ru.krug.backend.file.application.model.FileItemView;
import ru.krug.backend.file.application.model.FileMediaView;
import ru.krug.backend.file.application.model.FilePageView;
import ru.krug.backend.file.application.model.FileQuotaSummaryView;
import ru.krug.backend.file.application.model.MediaMetadataInput;
import ru.krug.backend.file.application.model.PreflightView;
import ru.krug.backend.file.application.model.UploadPartView;
import ru.krug.backend.file.application.model.UploadView;
import ru.krug.backend.file.application.model.WorkspaceLimitsView;

/** Application read models -> API DTOs. The API layer imports no domain classes. */
public final class FileApiMapper {

    private FileApiMapper() {
    }

    public static UploadSessionResponse toResponse(UploadView view) {
        return new UploadSessionResponse(view.uploadId(), view.status(), view.partSize(),
                view.totalParts(), view.receivedParts(), view.expiresAt(), view.attachmentId());
    }

    public static UploadPartResponse toResponse(UploadPartView view) {
        return new UploadPartResponse(view.partNo(), view.received(), view.etag(),
                view.sizeBytes());
    }

    public static DownloadUrlResponse toResponse(DownloadUrlView view) {
        return new DownloadUrlResponse(view.url(), view.expiresAt(), view.sizeBytes(),
                view.sha256());
    }

    public static WorkspaceLimitsResponse toResponse(WorkspaceLimitsView view) {
        return new WorkspaceLimitsResponse(view.tariff(), view.maxFileBytes(), view.storageBytes(),
                view.maxAttachments(), view.guestFileBytes(),
                new WorkspaceUsageResponse(view.usage().used(), view.usage().reserved(),
                        view.usage().limit()),
                view.maxChatsPerUser(), view.chatsUsed());
    }

    /** Untrusted wire object -> application input; validation happens in the handler. */
    public static MediaMetadataInput toInput(MediaMetadataRequest request) {
        if (request == null) {
            return null;
        }
        return new MediaMetadataInput(request.kind(), request.durationMs(), request.width(),
                request.height(), request.title(), request.artist(), request.album(),
                request.year(), request.genre(), request.artworkUrl(),
                request.metadataSource());
    }

    public static PreflightResponse toResponse(PreflightView view) {
        return new PreflightResponse(view.decision(), view.maxFileBytes(), view.maxAttachments(),
                new PreflightQuotaResponse(view.quota().used(), view.quota().reserved(),
                        view.quota().limit()),
                view.files().stream()
                        .map(file -> new PreflightDecisionResponse(file.name(), file.allowed(),
                                file.error(), file.details(), file.partSize()))
                        .toList());
    }

    public static FilePageResponse toResponse(FilePageView view) {
        return new FilePageResponse(view.items().stream()
                .map(FileApiMapper::toResponse)
                .toList(),
                new FilePageResponse.PageInfo(view.nextCursor(), view.hasMore()),
                quota(view.quota()));
    }

    private static FileItemResponse toResponse(FileItemView view) {
        return new FileItemResponse(view.id(), view.filename(), view.sizeBytes(),
                view.mimeType(), view.scanStatus(), media(view.media()), view.chatId(),
                view.chatName(), view.messageId(), view.createdAt());
    }

    private static FileMediaResponse media(FileMediaView media) {
        if (media == null) {
            return null;
        }
        return new FileMediaResponse(media.kind(), media.durationMs(), media.width(),
                media.height(), media.title(), media.artist(), media.album(), media.year(),
                media.genre(), media.artworkUrl(), media.metadataSource());
    }

    private static FileQuotaSummaryResponse quota(FileQuotaSummaryView quota) {
        if (quota == null) {
            return null;
        }
        return new FileQuotaSummaryResponse(quota.usedBytes(), quota.reservedBytes(),
                quota.storageBytes(), quota.percent());
    }
}
