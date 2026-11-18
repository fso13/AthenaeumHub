package ru.krug.backend.file.domain.repository;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import ru.krug.backend.file.domain.model.Upload;

public interface UploadRepository {

    void save(Upload upload);

    Optional<Upload> findById(UUID workspaceId, UUID uploadId);

    /** Locks the upload row; serialises part/complete/abort decisions for one session. */
    Optional<Upload> findForUpdate(UUID workspaceId, UUID uploadId);

    Optional<Upload> findForUpdateById(UUID uploadId);

    List<Upload> findExpired(Instant now, int limit);

    List<Upload> findScanning(int limit);

    List<Upload> findReadyUnboundBefore(Instant cutoff, int limit);

    /** Worker-role lookup used only to bind an upload id to its tenant before RLS. */
    Optional<Upload> findByIdForResolve(UUID uploadId);
}
