package ru.krug.backend.file.infrastructure.adapter;

import java.time.Instant;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import org.springframework.stereotype.Component;

import ru.krug.backend.auth.application.port.UserAvatarPort;
import ru.krug.backend.file.application.port.FileSettingsPort;
import ru.krug.backend.file.application.port.ObjectStoragePort;
import ru.krug.backend.file.domain.exception.AttachmentNotReadyException;
import ru.krug.backend.file.domain.exception.AttachmentQuarantinedException;
import ru.krug.backend.file.domain.model.Attachment;
import ru.krug.backend.file.domain.model.MediaKind;
import ru.krug.backend.file.domain.repository.AttachmentRepository;
import ru.krug.backend.shared.application.port.WorkerContext;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;
import ru.krug.backend.workspace.application.port.WorkspaceLogoPort;

/**
 * Avatar and workspace-logo validation over the existing managed-attachment pipeline.
 *
 * <p>No new upload endpoint: the caller uploads through the regular file flow and
 * references the resulting id. User avatars must be owned by the caller; workspace logos
 * must be in the same workspace. Both are image-only and fail closed on AV
 * ({@code 409 ATTACHMENT_NOT_READY}, {@code 423 ATTACHMENT_QUARANTINED}).</p>
 */
@Component
public class ProfileImageAdapter implements UserAvatarPort, WorkspaceLogoPort {

    private final WorkerContext workerContext;
    private final AttachmentRepository attachments;
    private final ObjectStoragePort storage;
    private final FileSettingsPort settings;

    public ProfileImageAdapter(WorkerContext workerContext, AttachmentRepository attachments,
                               ObjectStoragePort storage, FileSettingsPort settings) {
        this.workerContext = workerContext;
        this.attachments = attachments;
        this.storage = storage;
        this.settings = settings;
    }

    @Override
    public UUID requireAvatar(UUID userId, UUID attachmentId) {
        Attachment attachment = resolve(attachmentId)
                .filter(candidate -> candidate.userId().equals(userId))
                .orElseThrow(() -> DomainException.notFound("Attachment not found"));
        requireImage(attachment, ErrorCode.AVATAR_INVALID, "avatar");
        return attachment.id();
    }

    @Override
    public UUID requireLogo(UUID workspaceId, UUID attachmentId) {
        Attachment attachment = resolve(attachmentId)
                .filter(candidate -> candidate.workspaceId().equals(workspaceId))
                .orElseThrow(() -> DomainException.notFound("Attachment not found"));
        requireImage(attachment, ErrorCode.WORKSPACE_LOGO_INVALID, "logo");
        return attachment.id();
    }

    @Override
    public Optional<AvatarDownload> download(UUID attachmentId) {
        Attachment attachment = resolve(attachmentId).orElse(null);
        if (attachment == null) {
            return Optional.empty();
        }
        requireImage(attachment, ErrorCode.AVATAR_INVALID, "avatar");
        ObjectStoragePort.PresignedUrl url = storage.presignGet(attachment.objectKey(),
                settings.downloadTtl(), attachment.filename(), attachment.mimeType());
        Instant expiresAt = url.expiresAt();
        return Optional.of(new AvatarDownload(url.url(),
                expiresAt == null ? Instant.now().plus(settings.downloadTtl()) : expiresAt));
    }

    private Optional<Attachment> resolve(UUID attachmentId) {
        if (attachmentId == null) {
            return Optional.empty();
        }
        // Cross-tenant lookup by id only; the explicit owner/workspace check below is the
        // authorization decision. The caller restores its own tenant GUC afterwards.
        workerContext.activate(WorkerContext.WorkerRole.FILE_RESOLVE);
        return attachments.findByIdForResolve(attachmentId)
                .filter(candidate -> candidate.deletedAt() == null);
    }

    private static void requireImage(Attachment attachment, String errorCode, String field) {
        if (!isImage(attachment)) {
            throw DomainException.unprocessable(errorCode,
                    "An image attachment is required",
                    Map.of("field", field, "reason", "image_required"));
        }
        if (attachment.scanStatus().quarantined()) {
            throw new AttachmentQuarantinedException(attachment.scanStatus().name());
        }
        if (!attachment.isDownloadable()) {
            throw new AttachmentNotReadyException(attachment.status().name(),
                    attachment.scanStatus().name());
        }
    }

    private static boolean isImage(Attachment attachment) {
        if (attachment.media() != null && attachment.media().kind() == MediaKind.IMAGE) {
            return true;
        }
        String mime = attachment.mimeType();
        return mime != null && mime.toLowerCase(Locale.ROOT).startsWith("image/");
    }
}
