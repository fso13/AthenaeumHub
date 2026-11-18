package ru.krug.backend.file.api.mapper;

import ru.krug.backend.file.api.dto.DownloadUrlResponse;
import ru.krug.backend.file.api.dto.MediaMetadataRequest;
import ru.krug.backend.file.api.dto.PreflightDecisionResponse;
import ru.krug.backend.file.api.dto.PreflightQuotaResponse;
import ru.krug.backend.file.api.dto.PreflightResponse;
import ru.krug.backend.file.api.dto.UploadPartResponse;
import ru.krug.backend.file.api.dto.UploadSessionResponse;
import ru.krug.backend.file.api.dto.WorkspaceLimitsResponse;
import ru.krug.backend.file.api.dto.WorkspaceUsageResponse;
import ru.krug.backend.file.application.model.DownloadUrlView;
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
}
