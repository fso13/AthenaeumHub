package ru.krug.backend.file.application.usecase;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.file.application.command.CompleteUploadCommand;
import ru.krug.backend.file.application.model.UploadView;
import ru.krug.backend.file.application.port.ObjectStoragePort;
import ru.krug.backend.file.application.port.WorkspaceQuotaPort;
import ru.krug.backend.file.domain.exception.FileHashMismatchException;
import ru.krug.backend.file.domain.exception.IncompleteUploadException;
import ru.krug.backend.file.domain.exception.UploadExpiredException;
import ru.krug.backend.file.domain.exception.UploadNotFoundException;
import ru.krug.backend.file.domain.exception.UploadStateException;
import ru.krug.backend.file.domain.model.Attachment;
import ru.krug.backend.file.domain.model.Sha256;
import ru.krug.backend.file.domain.model.Upload;
import ru.krug.backend.file.domain.model.UploadPart;
import ru.krug.backend.file.domain.repository.AttachmentRepository;
import ru.krug.backend.file.domain.repository.UploadPartRepository;
import ru.krug.backend.file.domain.repository.UploadRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.TenantContext;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * Completes multipart, verifies whole-file hash and creates the attachment in SCANNING.
 * Quota is committed here exactly once (reserved -> used); message binding deliberately
 * does not touch used again. A repeated complete is idempotent by upload status.
 */
@Service
public class CompleteUploadHandler {

    private static final Logger log = LoggerFactory.getLogger(CompleteUploadHandler.class);

    private final FileAccessGuard accessGuard;
    private final UploadRepository uploadRepository;
    private final UploadPartRepository partRepository;
    private final AttachmentRepository attachmentRepository;
    private final ObjectStoragePort storage;
    private final WorkspaceQuotaPort quota;
    private final ClockPort clock;

    public CompleteUploadHandler(FileAccessGuard accessGuard, UploadRepository uploadRepository,
                                 UploadPartRepository partRepository,
                                 AttachmentRepository attachmentRepository,
                                 ObjectStoragePort storage, WorkspaceQuotaPort quota,
                                 ClockPort clock) {
        this.accessGuard = accessGuard;
        this.uploadRepository = uploadRepository;
        this.partRepository = partRepository;
        this.attachmentRepository = attachmentRepository;
        this.storage = storage;
        this.quota = quota;
        this.clock = clock;
    }

    @Transactional
    public UploadView complete(CompleteUploadCommand command) {
        Upload upload = lockOwned(command.principal(), command.uploadId());
        Instant now = clock.now();
        if (upload.status() == ru.krug.backend.file.domain.model.UploadStatus.EXPIRED
                || upload.isExpired(now)) {
            throw new UploadExpiredException(upload.expiresAt());
        }
        if (upload.status() == ru.krug.backend.file.domain.model.UploadStatus.SCANNING
                || upload.status() == ru.krug.backend.file.domain.model.UploadStatus.READY
                || upload.status() == ru.krug.backend.file.domain.model.UploadStatus.BOUND) {
            return view(upload);
        }
        if (upload.status() == ru.krug.backend.file.domain.model.UploadStatus.ABORTED
                || upload.status() == ru.krug.backend.file.domain.model.UploadStatus.QUARANTINED
                || upload.status() == ru.krug.backend.file.domain.model.UploadStatus.FAILED) {
            throw new UploadStateException(upload.status().name(), "complete");
        }

        Sha256 declared = Sha256.of(command.sha256());
        if (!upload.matchesDeclaredSha(declared)) {
            throw new FileHashMismatchException(upload.sha256().value(), declared.value());
        }
        Sha256 expected = upload.sha256() == null ? declared : upload.sha256();

        List<UploadPart> parts = partRepository.findByUploadId(upload.id()).stream()
                .sorted(Comparator.comparingInt(UploadPart::partNo))
                .toList();
        List<Integer> missing = missingParts(parts, upload.totalParts());
        if (!missing.isEmpty() || parts.size() != upload.totalParts()
                || command.partsCount() != upload.totalParts()) {
            throw new IncompleteUploadException(upload.totalParts(), command.partsCount(), missing);
        }
        long totalBytes = parts.stream().mapToLong(UploadPart::sizeBytes).sum();
        if (totalBytes != upload.sizeBytes()) {
            throw DomainException.unprocessable(ErrorCode.INCOMPLETE_UPLOAD,
                    "Uploaded bytes do not match the declared file size",
                    Map.of("expected", upload.sizeBytes(), "actual", totalBytes));
        }

        if (!storage.exists(upload.objectKey())) {
            List<ObjectStoragePort.Part> etags = parts.stream()
                    .map(part -> new ObjectStoragePort.Part(part.partNo(), part.etag()))
                    .toList();
            storage.completeMultipart(upload.objectKey(), upload.storageUploadId(), etags);
        }
        String actualSha = storage.sha256Hex(upload.objectKey());
        if (!expected.value().equals(actualSha)) {
            // The object is unusable. The reservation is released by the expiry GC if this
            // transaction rolls back; do not leave a downloadable attachment behind.
            try {
                storage.delete(upload.objectKey());
            } catch (RuntimeException ex) {
                log.warn("file.complete.cleanup_failed upload_id={}", upload.id());
            }
            throw new FileHashMismatchException(expected.value(), actualSha);
        }

        Attachment attachment = Attachment.uploaded(UUID.randomUUID(), upload.workspaceId(),
                upload.chatId(), upload.id(), upload.userId(), upload.filename(),
                upload.mimeType(), upload.media(), upload.sizeBytes(), expected,
                upload.objectKey(), now);
        attachmentRepository.save(attachment);
        Upload scanning = upload.markScanning(attachment.id(), now);
        if (upload.sha256() == null) {
            scanning = scanning.withSha(expected, now);
        }
        uploadRepository.save(scanning);
        quota.commit(upload.workspaceId(), upload.id(), now);
        return view(scanning);
    }

    private UploadView view(Upload upload) {
        List<Integer> received = partRepository.findByUploadId(upload.id()).stream()
                .map(UploadPart::partNo).sorted().toList();
        return UploadView.from(upload, received);
    }

    private static List<Integer> missingParts(List<UploadPart> parts, int totalParts) {
        List<Integer> present = new ArrayList<>(
                parts.stream().map(UploadPart::partNo).toList());
        List<Integer> missing = new ArrayList<>();
        for (int partNo = 1; partNo <= totalParts; partNo++) {
            if (!present.contains(partNo)) {
                missing.add(partNo);
            }
        }
        return missing;
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
