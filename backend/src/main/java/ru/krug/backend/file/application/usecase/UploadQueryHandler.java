package ru.krug.backend.file.application.usecase;

import java.util.List;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.file.application.model.UploadView;
import ru.krug.backend.file.domain.exception.UploadExpiredException;
import ru.krug.backend.file.domain.exception.UploadNotFoundException;
import ru.krug.backend.file.domain.model.Upload;
import ru.krug.backend.file.domain.model.UploadStatus;
import ru.krug.backend.file.domain.repository.UploadPartRepository;
import ru.krug.backend.file.domain.repository.UploadRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.TenantContext;

/** Resume endpoint: status + received parts, so the client downloads only missing parts. */
@Service
public class UploadQueryHandler {

    private final FileAccessGuard accessGuard;
    private final UploadRepository uploadRepository;
    private final UploadPartRepository partRepository;
    private final ClockPort clock;

    public UploadQueryHandler(FileAccessGuard accessGuard, UploadRepository uploadRepository,
                              UploadPartRepository partRepository, ClockPort clock) {
        this.accessGuard = accessGuard;
        this.uploadRepository = uploadRepository;
        this.partRepository = partRepository;
        this.clock = clock;
    }

    @Transactional(readOnly = true)
    public UploadView get(Principal principal, UUID uploadId) {
        Principal scoped = accessGuard.activateUploadScope(principal, uploadId);
        Upload upload = uploadRepository.findById(scoped.workspaceId(), uploadId)
                .orElseThrow(UploadNotFoundException::new);
        if (!upload.userId().equals(scoped.userId())) {
            throw new UploadNotFoundException();
        }
        if (upload.status() == UploadStatus.EXPIRED || upload.isExpired(clock.now())) {
            throw new UploadExpiredException(upload.expiresAt());
        }
        List<Integer> received = partRepository.findByUploadId(uploadId).stream()
                .map(part -> part.partNo()).sorted().toList();
        return UploadView.from(upload, received);
    }
}
