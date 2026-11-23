package ru.krug.backend.file.application.usecase;

import java.time.Instant;
import java.util.Map;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.audit.application.model.AuditRecord;
import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.file.application.model.FileItemView;
import ru.krug.backend.file.application.model.FileMediaView;
import ru.krug.backend.file.application.port.ObjectStoragePort;
import ru.krug.backend.file.application.port.WorkspaceQuotaPort;
import ru.krug.backend.file.domain.exception.UploadNotFoundException;
import ru.krug.backend.file.domain.model.Attachment;
import ru.krug.backend.file.domain.model.AttachmentStatus;
import ru.krug.backend.file.domain.model.MediaKind;
import ru.krug.backend.file.domain.service.AudioArtworkKey;
import ru.krug.backend.file.domain.service.SafeFileName;
import ru.krug.backend.file.domain.repository.AttachmentRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.ContentDlpPort;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;
import ru.krug.backend.workspace.application.port.WorkspaceAccessPort;

/**
 * {@code PATCH /files/{fileId}} and {@code DELETE /files/{fileId}} (#83).
 *
 * <ul>
 *   <li>Rename: owner only. Changes the display name only; the object key, hash and scan
 *       verdict are untouched.</li>
 *   <li>Delete: owner or workspace OWNER/ADMIN. Soft delete (row retained for the audit /
 *       attachment references) plus object deletion and committed-quota release. A file that
 *       is already attached to a live message cannot be deleted on its own (409): the message
 *       owns it, and deleting it would leave a dangling reference.</li>
 *   <li>Trusted direct images (avatars/covers/logos) are not managed by this file API, they
 *       have their own replace/remove flow.</li>
 * </ul>
 */
@Service
public class FileMutationService {

    static final String RENAME_ACTION = "file.renamed";
    static final String DELETE_ACTION = "file.deleted";

    private static final Logger log = LoggerFactory.getLogger(FileMutationService.class);

    private final FileAccessGuard accessGuard;
    private final AttachmentRepository attachments;
    private final WorkspaceQuotaPort quota;
    private final ObjectStoragePort storage;
    private final WorkspaceAccessPort workspaceAccess;
    private final AuditPort audit;
    private final ContentDlpPort dlp;
    private final ClockPort clock;

    public FileMutationService(FileAccessGuard accessGuard, AttachmentRepository attachments,
                               WorkspaceQuotaPort quota, ObjectStoragePort storage,
                               WorkspaceAccessPort workspaceAccess, AuditPort audit,
                               ContentDlpPort dlp, ClockPort clock) {
        this.accessGuard = accessGuard;
        this.attachments = attachments;
        this.quota = quota;
        this.storage = storage;
        this.workspaceAccess = workspaceAccess;
        this.audit = audit;
        this.dlp = dlp;
        this.clock = clock;
    }

    @Transactional
    public FileItemView rename(Principal principal, UUID attachmentId, String filename) {
        String safeName = SafeFileName.require(filename);
        Principal scoped = accessGuard.activateAttachmentScope(principal, attachmentId);
        Attachment attachment = attachments.findForUpdate(scoped.workspaceId(), attachmentId)
                .orElseThrow(UploadNotFoundException::new);
        requireOwner(scoped, attachment);
        requireActive(attachment);
        // #101: a rename must not bypass an attachment rule. The check uses the new
        // filename; a BLOCK leaves the stored name unchanged.
        dlp.enforceAttachment(scoped, attachment.chatId(), safeName,
                attachment.mimeType(), attachment.sizeBytes());

        Instant now = clock.now();
        Attachment renamed = attachment.rename(safeName, now);
        attachments.save(renamed);
        audit.append(new AuditRecord(scoped.workspaceId(), scoped.userId(), RENAME_ACTION,
                "attachment", attachmentId, scoped.requestId(),
                Map.of("size_bytes", attachment.sizeBytes()), now));
        return view(renamed);
    }

    @Transactional
    public void delete(Principal principal, UUID attachmentId) {
        Principal scoped = accessGuard.activateAttachmentScope(principal, attachmentId);
        Attachment attachment = attachments.findForUpdate(scoped.workspaceId(), attachmentId)
                .orElseThrow(UploadNotFoundException::new);
        if (attachment.status() == AttachmentStatus.DELETED) {
            return;
        }
        boolean owner = attachment.isOwnedBy(scoped.userId());
        boolean admin = workspaceAccess.isAdmin(scoped.workspaceId(), scoped.userId());
        if (!owner && !admin) {
            throw DomainException.forbidden("Only the owner or a workspace admin can delete "
                    + "this file");
        }
        if (attachment.isDirectImage()) {
            throw DomainException.unprocessable(ErrorCode.IMAGE_INVALID,
                    "A direct image is managed by its avatar/cover/logo endpoint",
                    Map.of("field", "file_id", "reason", "direct_image_not_deletable"));
        }
        if (attachment.messageId() != null) {
            throw DomainException.conflict(ErrorCode.CONFLICT,
                    "An attached file cannot be deleted separately from its message",
                    Map.of("field", "file_id", "reason", "attached_to_message"));
        }

        Instant now = clock.now();
        attachments.save(attachment.markDeleted(now));
        // Only a committed upload reservation can be released; a no-op otherwise (status
        // guarded in the quota adapter). Direct images never reach this branch.
        if (attachment.uploadId() != null) {
            quota.releaseCommitted(scoped.workspaceId(), attachment.uploadId(), now);
        }
        try {
            storage.delete(attachment.objectKey());
        } catch (RuntimeException ex) {
            log.warn("file.delete.object_failed attachment_id={}", attachmentId);
        }
        if (attachment.media() != null && attachment.media().kind() == MediaKind.AUDIO) {
            try {
                storage.delete(AudioArtworkKey.forAttachment(scoped.workspaceId(),
                        attachmentId));
            } catch (RuntimeException ex) {
                log.warn("file.delete.artwork_failed attachment_id={}", attachmentId);
            }
        }
        audit.append(new AuditRecord(scoped.workspaceId(), scoped.userId(), DELETE_ACTION,
                "attachment", attachmentId, scoped.requestId(),
                Map.of("size_bytes", attachment.sizeBytes(), "owner", attachment.userId(),
                        "by_admin", !owner), now));
    }

    private static void requireOwner(Principal principal, Attachment attachment) {
        if (!attachment.isOwnedBy(principal.userId())) {
            // Hide existence from a non-owner instead of disclosing the file.
            throw new UploadNotFoundException();
        }
    }

    private static void requireActive(Attachment attachment) {
        if (attachment.status() == AttachmentStatus.DELETED) {
            throw new DomainException(ru.krug.backend.shared.error.ErrorCategory.GONE,
                    ErrorCode.ATTACHMENT_DELETED, "File is deleted", Map.of(), null);
        }
    }

    private static FileItemView view(Attachment attachment) {
        FileMediaView media = attachment.media() == null ? null
                : new FileMediaView(attachment.media().kind().name(),
                        attachment.media().durationMs(), attachment.media().width(),
                        attachment.media().height(), attachment.media().title(),
                        attachment.media().artist(), attachment.media().album(),
                        attachment.media().year(), attachment.media().genre(),
                        attachment.media().artworkUrl(),
                        attachment.media().metadataSource().name());
        return new FileItemView(attachment.id(), attachment.filename(), attachment.sizeBytes(),
                attachment.mimeType(), attachment.scanStatus().name(), media,
                attachment.chatId(), null, attachment.messageId(), attachment.createdAt());
    }

}
