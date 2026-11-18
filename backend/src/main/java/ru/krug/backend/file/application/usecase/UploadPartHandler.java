package ru.krug.backend.file.application.usecase;

import java.time.Instant;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.file.application.command.PutPartCommand;
import ru.krug.backend.file.application.model.UploadPartView;
import ru.krug.backend.file.application.port.ObjectStoragePort;
import ru.krug.backend.file.domain.exception.ChunkConflictException;
import ru.krug.backend.file.domain.exception.ChunkHashMismatchException;
import ru.krug.backend.file.domain.exception.InvalidChunkException;
import ru.krug.backend.file.domain.exception.UploadNotFoundException;
import ru.krug.backend.file.domain.model.Sha256;
import ru.krug.backend.file.domain.model.Upload;
import ru.krug.backend.file.domain.model.UploadPart;
import ru.krug.backend.file.domain.repository.UploadPartRepository;
import ru.krug.backend.file.domain.repository.UploadRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.TenantContext;

/**
 * Idempotent chunk upload. The upload row is locked so part/complete/abort decisions for a
 * session are serialised; a repeat with the same hash returns the stored part, a repeat
 * with a different hash is 409 CHUNK_CONFLICT, a hash/size mismatch is 422.
 */
@Service
public class UploadPartHandler {

    private final FileAccessGuard accessGuard;
    private final UploadRepository uploadRepository;
    private final UploadPartRepository partRepository;
    private final ObjectStoragePort storage;
    private final ClockPort clock;

    public UploadPartHandler(FileAccessGuard accessGuard, UploadRepository uploadRepository,
                             UploadPartRepository partRepository, ObjectStoragePort storage,
                             ClockPort clock) {
        this.accessGuard = accessGuard;
        this.uploadRepository = uploadRepository;
        this.partRepository = partRepository;
        this.storage = storage;
        this.clock = clock;
    }

    @Transactional
    public UploadPartView put(PutPartCommand command) {
        Upload upload = lockOwned(command.principal(), command.uploadId());
        Instant now = clock.now();
        upload.assertAcceptingParts(now);
        if (command.partNo() < 1 || command.partNo() > upload.totalParts()) {
            throw InvalidChunkException.outOfRange(command.partNo(), upload.totalParts());
        }
        long expectedLength = upload.expectedPartLength(command.partNo());
        if (command.content() == null || command.content().length != expectedLength) {
            throw InvalidChunkException.sizeMismatch(command.partNo(), expectedLength,
                    command.content() == null ? 0 : command.content().length);
        }
        Sha256 declared = Sha256.of(command.sha256());
        Sha256 actual = Sha256.ofBytes(command.content());
        if (!declared.matches(actual)) {
            throw new ChunkHashMismatchException(command.partNo(), declared.value(),
                    actual.value());
        }

        UploadPart existing = partRepository.find(upload.id(), command.partNo()).orElse(null);
        if (existing != null) {
            if (!existing.sameHash(declared)) {
                throw new ChunkConflictException(command.partNo());
            }
            return UploadPartView.from(existing);
        }

        String etag = storage.uploadPart(upload.objectKey(), upload.storageUploadId(),
                command.partNo(), command.content());
        UploadPart part = UploadPart.received(upload.id(), upload.workspaceId(), command.partNo(),
                declared, command.content().length, etag, now);
        UploadPart stored = partRepository.insertIfAbsent(part);
        if (!stored.sameHash(declared)) {
            throw new ChunkConflictException(command.partNo());
        }
        uploadRepository.save(upload.markUploading(now));
        return UploadPartView.from(stored);
    }

    private Upload lockOwned(Principal principal, UUID uploadId) {
        Principal scoped = accessGuard.activateUploadScope(principal, uploadId);
        Upload upload = uploadRepository.findForUpdate(scoped.workspaceId(), uploadId)
                .orElseThrow(UploadNotFoundException::new);
        if (!upload.userId().equals(scoped.userId())) {
            // Hide the existence of another user's upload.
            throw new UploadNotFoundException();
        }
        return upload;
    }
}
