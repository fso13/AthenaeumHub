package ru.krug.backend.file.application.usecase;

import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.file.application.model.DownloadUrlView;
import ru.krug.backend.file.application.port.FileSettingsPort;
import ru.krug.backend.file.application.port.ObjectStoragePort;
import ru.krug.backend.file.domain.exception.UploadNotFoundException;
import ru.krug.backend.file.domain.model.Attachment;
import ru.krug.backend.file.domain.repository.AttachmentRepository;
import ru.krug.backend.chat.application.port.ChatAccessPort;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.TenantContext;

/**
 * Presigned download URL (TTL 5 min). AV is fail-closed: SCANNING -> 409, quarantined -> 423.
 * Unbound attachments are visible only to their uploader; bound attachments require active
 * chat membership (so a recipient can download, a stranger cannot).
 */
@Service
public class AttachmentDownloadHandler {

    private final TenantContext tenantContext;
    private final FileAccessGuard accessGuard;
    private final AttachmentRepository attachmentRepository;
    private final ChatAccessPort chatAccess;
    private final ObjectStoragePort storage;
    private final FileSettingsPort settings;
    private final ClockPort clock;

    public AttachmentDownloadHandler(TenantContext tenantContext, FileAccessGuard accessGuard,
                                     AttachmentRepository attachmentRepository,
                                     ChatAccessPort chatAccess, ObjectStoragePort storage,
                                     FileSettingsPort settings, ClockPort clock) {
        this.tenantContext = tenantContext;
        this.accessGuard = accessGuard;
        this.attachmentRepository = attachmentRepository;
        this.chatAccess = chatAccess;
        this.storage = storage;
        this.settings = settings;
        this.clock = clock;
    }

    @Transactional(readOnly = true)
    public DownloadUrlView downloadUrl(Principal principal, UUID attachmentId) {
        Principal scoped = accessGuard.activateAttachmentScope(principal, attachmentId);
        Attachment attachment = attachmentRepository
                .findById(scoped.workspaceId(), attachmentId)
                .orElseThrow(UploadNotFoundException::new);
        if (attachment.messageId() != null) {
            chatAccess.requireActiveChat(scoped.workspaceId(), attachment.chatId(),
                    scoped.userId());
        } else if (!attachment.isOwnedBy(scoped.userId())) {
            throw new UploadNotFoundException();
        }
        attachment.assertDownloadable();
        ObjectStoragePort.PresignedUrl url = storage.presignGet(attachment.objectKey(),
                settings.downloadTtl(), attachment.filename(), attachment.mimeType());
        return new DownloadUrlView(url.url(),
                url.expiresAt() == null ? clock.now().plus(settings.downloadTtl())
                        : url.expiresAt(),
                attachment.sizeBytes(), attachment.sha256().value());
    }
}
