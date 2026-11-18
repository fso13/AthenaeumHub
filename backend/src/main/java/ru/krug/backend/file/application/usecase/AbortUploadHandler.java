package ru.krug.backend.file.application.usecase;

import java.time.Instant;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.file.application.command.AbortUploadCommand;
import ru.krug.backend.file.application.port.ObjectStoragePort;
import ru.krug.backend.file.application.port.WorkspaceQuotaPort;
import ru.krug.backend.file.domain.exception.UploadNotFoundException;
import ru.krug.backend.file.domain.exception.UploadStateException;
import ru.krug.backend.file.domain.model.Upload;
import ru.krug.backend.file.domain.model.UploadStatus;
import ru.krug.backend.file.domain.repository.UploadRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.TenantContext;

/** Aborts an active upload, releases its ACTIVE reservation and aborts S3 multipart. */
@Service
public class AbortUploadHandler {

    private static final Logger log = LoggerFactory.getLogger(AbortUploadHandler.class);

    private final FileAccessGuard accessGuard;
    private final UploadRepository uploadRepository;
    private final ObjectStoragePort storage;
    private final WorkspaceQuotaPort quota;
    private final ClockPort clock;

    public AbortUploadHandler(FileAccessGuard accessGuard, UploadRepository uploadRepository,
                              ObjectStoragePort storage, WorkspaceQuotaPort quota, ClockPort clock) {
        this.accessGuard = accessGuard;
        this.uploadRepository = uploadRepository;
        this.storage = storage;
        this.quota = quota;
        this.clock = clock;
    }

    @Transactional
    public void abort(AbortUploadCommand command) {
        Upload upload = lockOwned(command.principal(), command.uploadId());
        if (upload.status() == UploadStatus.ABORTED) {
            return;
        }
        if (upload.status() == UploadStatus.EXPIRED || upload.isExpired(clock.now())) {
            throw new ru.krug.backend.file.domain.exception.UploadExpiredException(
                    upload.expiresAt());
        }
        if (!upload.status().canAbort()) {
            throw new UploadStateException(upload.status().name(), "abort");
        }
        Instant now = clock.now();
        uploadRepository.save(upload.abort(now));
        quota.releaseActive(upload.workspaceId(), upload.id(), now, false);
        if (upload.storageUploadId() != null) {
            try {
                storage.abortMultipart(upload.objectKey(), upload.storageUploadId());
            } catch (RuntimeException ex) {
                // The DB release is the source of truth; a stale multipart is cleaned by
                // the S3 lifecycle rule / next abort attempt.
                log.warn("file.abort.s3_failed upload_id={}", upload.id());
            }
        }
    }

    private Upload lockOwned(Principal principal, UUID uploadId) {
        Principal scoped = accessGuard.activateUploadScope(principal, uploadId);
        Upload upload = uploadRepository.findForUpdate(scoped.workspaceId(), uploadId)
                .orElseThrow(UploadNotFoundException::new);
        if (!upload.userId().equals(scoped.userId())) {
            throw new UploadNotFoundException();
        }
        return upload;
    }
}
