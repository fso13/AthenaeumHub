package ru.krug.backend.file.application.usecase;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.file.application.port.MalwareScanPort;
import ru.krug.backend.file.application.port.ObjectStoragePort;
import ru.krug.backend.file.application.port.WorkspaceQuotaPort;
import ru.krug.backend.file.domain.model.Attachment;
import ru.krug.backend.file.domain.model.AttachmentStatus;
import ru.krug.backend.file.domain.model.ScanStatus;
import ru.krug.backend.file.domain.model.Upload;
import ru.krug.backend.file.domain.model.UploadStatus;
import ru.krug.backend.file.domain.repository.AttachmentRepository;
import ru.krug.backend.file.domain.repository.UploadRepository;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.WorkerContext;

/**
 * Scans one SCANNING upload. AV outcome: CLEAN -> READY, INFECTED/FAILED -> QUARANTINED
 * (fail-closed), release the committed quota and delete the object. Runs under the narrow
 * transaction-local file-scan worker role.
 */
@Service
public class UploadScanHandler {

    private static final Logger log = LoggerFactory.getLogger(UploadScanHandler.class);

    private final WorkerContext workerContext;
    private final UploadRepository uploadRepository;
    private final AttachmentRepository attachmentRepository;
    private final MalwareScanPort scanner;
    private final ObjectStoragePort storage;
    private final WorkspaceQuotaPort quota;
    private final ClockPort clock;

    public UploadScanHandler(WorkerContext workerContext, UploadRepository uploadRepository,
                             AttachmentRepository attachmentRepository,
                             MalwareScanPort scanner, ObjectStoragePort storage,
                             WorkspaceQuotaPort quota, ClockPort clock) {
        this.workerContext = workerContext;
        this.uploadRepository = uploadRepository;
        this.attachmentRepository = attachmentRepository;
        this.scanner = scanner;
        this.storage = storage;
        this.quota = quota;
        this.clock = clock;
    }

    @Transactional
    public void scanOne(UUID uploadId) {
        workerContext.activate(WorkerContext.WorkerRole.FILE_SCAN);
        Upload upload = uploadRepository.findForUpdateById(uploadId).orElse(null);
        if (upload == null || upload.status() != UploadStatus.SCANNING) {
            return;
        }
        Attachment attachment = attachmentRepository.findByUploadId(uploadId).orElse(null);
        if (attachment == null) {
            log.warn("file.scan.attachment_missing upload_id={}", uploadId);
            uploadRepository.save(upload.markFailed(clock.now()));
            quota.releaseCommitted(upload.workspaceId(), uploadId, clock.now());
            return;
        }
        if (attachment.status() == AttachmentStatus.DELETED) {
            // #83: the owner/admin deleted the global file while it was still scanning. Do
            // not resurrect it to READY by writing an AV verdict; the object and quota were
            // already released by the delete, so the session is simply closed.
            log.info("file.scan.attachment_deleted upload_id={}", uploadId);
            uploadRepository.save(upload.markFailed(clock.now()));
            return;
        }
        Instant now = clock.now();
        MalwareScanPort.ScanResult result;
        try {
            result = scanner.scan(new MalwareScanPort.ScanRequest(attachment.id(),
                    attachment.objectKey(), attachment.filename(), attachment.mimeType(),
                    attachment.sizeBytes()));
        } catch (RuntimeException ex) {
            log.warn("file.scan.crashed attachment_id={} type={}", attachment.id(),
                    ex.getClass().getSimpleName());
            result = MalwareScanPort.ScanResult.failed("unknown");
        }

        // Write only the verdict columns: a rename/delete that committed during the scan
        // must not be clobbered, and a DELETED row must never be resurrected (0 rows).
        if (result.status() == ScanStatus.CLEAN) {
            if (!applyVerdict(attachment, AttachmentStatus.READY, ScanStatus.CLEAN, now)) {
                uploadRepository.save(upload.markFailed(now));
                return;
            }
            uploadRepository.save(upload.markReady(now));
            return;
        }
        if (result.status() == ScanStatus.SKIPPED) {
            if (!applyVerdict(attachment, AttachmentStatus.READY, ScanStatus.SKIPPED, now)) {
                uploadRepository.save(upload.markFailed(now));
                return;
            }
            uploadRepository.save(upload.markReady(now));
            return;
        }

        // INFECTED or FAILED: quarantine is fail-closed. Release the committed quota once
        // and remove the object; the attachment row remains for audit (download returns 423).
        if (result.status() == ScanStatus.INFECTED) {
            if (!applyVerdict(attachment, AttachmentStatus.QUARANTINED, ScanStatus.INFECTED,
                    now)) {
                uploadRepository.save(upload.markFailed(now));
                return;
            }
            log.warn("file.scan.infected attachment_id={} engine={} signature={}",
                    attachment.id(), result.engine(), result.signature());
        } else {
            if (!applyVerdict(attachment, AttachmentStatus.QUARANTINED, ScanStatus.FAILED, now)) {
                uploadRepository.save(upload.markFailed(now));
                return;
            }
            log.warn("file.scan.failed attachment_id={} engine={}", attachment.id(),
                    result.engine());
        }
        uploadRepository.save(upload.markQuarantined(now));
        quota.releaseCommitted(upload.workspaceId(), uploadId, now);
        try {
            storage.delete(upload.objectKey());
        } catch (RuntimeException ex) {
            log.warn("file.scan.delete_failed upload_id={}", uploadId);
        }
    }

    private boolean applyVerdict(Attachment attachment, AttachmentStatus status,
                                 ScanStatus scanStatus, Instant now) {
        return attachmentRepository.updateScanVerdict(attachment.id(), status, scanStatus,
                now) > 0;
    }

    @Transactional(readOnly = true)
    public List<UUID> pendingUploadIds(int limit) {
        workerContext.activate(WorkerContext.WorkerRole.FILE_SCAN);
        return uploadRepository.findScanning(limit).stream().map(Upload::id).toList();
    }
}
