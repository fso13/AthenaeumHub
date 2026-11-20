package ru.krug.backend.file.application.usecase;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.file.application.port.ObjectStoragePort;
import ru.krug.backend.file.application.port.WorkspaceQuotaPort;
import ru.krug.backend.file.domain.model.Attachment;
import ru.krug.backend.file.domain.model.AttachmentStatus;
import ru.krug.backend.file.domain.model.Upload;
import ru.krug.backend.file.domain.model.UploadStatus;
import ru.krug.backend.file.domain.repository.AttachmentRepository;
import ru.krug.backend.file.domain.repository.QuotaReservationRepository;
import ru.krug.backend.file.domain.repository.UploadRepository;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.WorkerContext;

/**
 * Expires uploads whose 24h TTL elapsed: abort multipart, delete unbound objects, release
 * exactly one reservation state (ACTIVE or COMMITTED). Runs under the file-gc worker role.
 */
@Service
public class UploadGcHandler {

    private static final Logger log = LoggerFactory.getLogger(UploadGcHandler.class);

    private final WorkerContext workerContext;
    private final UploadRepository uploadRepository;
    private final AttachmentRepository attachmentRepository;
    private final QuotaReservationRepository reservationRepository;
    private final ObjectStoragePort storage;
    private final WorkspaceQuotaPort quota;
    private final ClockPort clock;

    public UploadGcHandler(WorkerContext workerContext, UploadRepository uploadRepository,
                           AttachmentRepository attachmentRepository,
                           QuotaReservationRepository reservationRepository,
                           ObjectStoragePort storage, WorkspaceQuotaPort quota, ClockPort clock) {
        this.workerContext = workerContext;
        this.uploadRepository = uploadRepository;
        this.attachmentRepository = attachmentRepository;
        this.reservationRepository = reservationRepository;
        this.storage = storage;
        this.quota = quota;
        this.clock = clock;
    }

    @Transactional(readOnly = true)
    public List<UUID> expiredUploadIds(int limit) {
        workerContext.activate(WorkerContext.WorkerRole.FILE_GC);
        return uploadRepository.findExpired(clock.now(), limit).stream().map(Upload::id).toList();
    }

    @Transactional
    public void gcOne(UUID uploadId) {
        workerContext.activate(WorkerContext.WorkerRole.FILE_GC);
        Upload upload = uploadRepository.findForUpdateById(uploadId).orElse(null);
        if (upload == null || upload.status() == UploadStatus.ABORTED
                || upload.status() == UploadStatus.EXPIRED
                || upload.status() == UploadStatus.BOUND
                || upload.status() == UploadStatus.QUARANTINED
                || upload.status() == UploadStatus.FAILED) {
            return;
        }
        Instant now = clock.now();
        if (!now.isAfter(upload.expiresAt())) {
            return;
        }

        Attachment attachment = attachmentRepository.findByUploadId(uploadId).orElse(null);
        if (attachment != null && attachment.status() != AttachmentStatus.DELETED) {
            attachmentRepository.save(attachment.markDeleted(now));
            try {
                storage.delete(upload.objectKey());
            } catch (RuntimeException ex) {
                log.warn("file.gc.delete_failed upload_id={}", uploadId);
            }
        } else if (upload.storageUploadId() != null) {
            try {
                storage.abortMultipart(upload.objectKey(), upload.storageUploadId());
            } catch (RuntimeException ex) {
                log.warn("file.gc.abort_failed upload_id={}", uploadId);
            }
        }

        // The reservation is either still ACTIVE (no complete) or COMMITTED (complete but
        // never bound). Both release methods are status-guarded, so at most one changes use.
        boolean committed = reservationRepository.findByUploadId(uploadId)
                .map(reservation -> reservation.isCommitted()).orElse(false);
        if (committed) {
            quota.releaseCommitted(upload.workspaceId(), uploadId, now);
        } else {
            quota.releaseActive(upload.workspaceId(), uploadId, now, true);
        }
        uploadRepository.save(upload.expire(now));
    }

    /** Unbound READY attachments older than the upload TTL (defence in depth). */
    @Transactional
    public void gcUnboundAttachment(UUID attachmentId) {
        workerContext.activate(WorkerContext.WorkerRole.FILE_GC);
        Attachment attachment = attachmentRepository.findForUpdateById(attachmentId).orElse(null);
        if (attachment == null || attachment.status() != AttachmentStatus.READY
                || attachment.messageId() != null) {
            return;
        }
        // #92: direct images have no upload session and are referenced by avatar/cover/logo
        // rows, not by messages. They must not be deleted by the upload TTL GC.
        if (attachment.isDirectImage() || attachment.uploadId() == null) {
            return;
        }
        Instant now = clock.now();
        attachmentRepository.save(attachment.markDeleted(now));
        try {
            storage.delete(attachment.objectKey());
        } catch (RuntimeException ex) {
            log.warn("file.gc.attachment_delete_failed attachment_id={}", attachmentId);
        }
        quota.releaseCommitted(attachment.workspaceId(), attachment.uploadId(), now);
        uploadRepository.findForUpdateById(attachment.uploadId())
                .filter(upload -> upload.status() == UploadStatus.READY)
                .ifPresent(upload -> uploadRepository.save(upload.expire(now)));
    }
}
