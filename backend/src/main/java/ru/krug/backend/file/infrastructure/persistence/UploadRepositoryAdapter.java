package ru.krug.backend.file.infrastructure.persistence;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import jakarta.persistence.EntityManager;

import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Repository;

import ru.krug.backend.file.domain.model.Upload;
import ru.krug.backend.file.domain.repository.UploadRepository;

@Repository
public class UploadRepositoryAdapter implements UploadRepository {

    private final UploadJpaRepository jpaRepository;
    private final EntityManager entityManager;

    public UploadRepositoryAdapter(UploadJpaRepository jpaRepository,
                                   EntityManager entityManager) {
        this.jpaRepository = jpaRepository;
        this.entityManager = entityManager;
    }

    @Override
    public void save(Upload upload) {
        entityManager.merge(UploadEntity.from(upload));
    }

    @Override
    public Optional<Upload> findById(UUID workspaceId, UUID uploadId) {
        return jpaRepository.findByIdAndWorkspaceId(uploadId, workspaceId)
                .map(UploadEntity::toDomain);
    }

    @Override
    public Optional<Upload> findForUpdate(UUID workspaceId, UUID uploadId) {
        return jpaRepository.findForUpdate(uploadId, workspaceId).map(UploadEntity::toDomain);
    }

    @Override
    public Optional<Upload> findForUpdateById(UUID uploadId) {
        return jpaRepository.findForUpdateById(uploadId).map(UploadEntity::toDomain);
    }

    @Override
    public List<Upload> findExpired(Instant now, int limit) {
        return jpaRepository.findExpired(now, PageRequest.of(0, limit)).stream()
                .map(UploadEntity::toDomain).toList();
    }

    @Override
    public List<Upload> findScanning(int limit) {
        return jpaRepository.findScanning(PageRequest.of(0, limit)).stream()
                .map(UploadEntity::toDomain).toList();
    }

    @Override
    public List<Upload> findReadyUnboundBefore(Instant cutoff, int limit) {
        return jpaRepository.findUnboundReadyBefore(cutoff, PageRequest.of(0, limit)).stream()
                .map(UploadEntity::toDomain).toList();
    }

    @Override
    public Optional<Upload> findByIdForResolve(UUID uploadId) {
        return jpaRepository.findById(uploadId).map(UploadEntity::toDomain);
    }
}
