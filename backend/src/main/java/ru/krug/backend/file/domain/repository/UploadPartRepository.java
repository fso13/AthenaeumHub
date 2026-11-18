package ru.krug.backend.file.domain.repository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

import ru.krug.backend.file.domain.model.Sha256;
import ru.krug.backend.file.domain.model.UploadPart;

public interface UploadPartRepository {

    void save(UploadPart part);

    Optional<UploadPart> find(UUID uploadId, int partNo);

    List<UploadPart> findByUploadId(UUID uploadId);

    void deleteByUploadId(UUID uploadId);

    /**
     * Inserts a part if absent and returns the stored row. The etag/size of an existing
     * part are never overwritten; the caller resolves hash equality.
     */
    UploadPart insertIfAbsent(UploadPart part);

    boolean existsWithDifferentHash(UUID uploadId, int partNo, Sha256 sha256);
}
