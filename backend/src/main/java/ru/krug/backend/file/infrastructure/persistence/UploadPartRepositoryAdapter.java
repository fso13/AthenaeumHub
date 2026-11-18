package ru.krug.backend.file.infrastructure.persistence;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

import jakarta.persistence.EntityManager;

import org.springframework.stereotype.Repository;

import ru.krug.backend.file.domain.model.Sha256;
import ru.krug.backend.file.domain.model.UploadPart;
import ru.krug.backend.file.domain.repository.UploadPartRepository;

@Repository
public class UploadPartRepositoryAdapter implements UploadPartRepository {

    private final UploadPartJpaRepository jpaRepository;
    private final EntityManager entityManager;

    public UploadPartRepositoryAdapter(UploadPartJpaRepository jpaRepository,
                                       EntityManager entityManager) {
        this.jpaRepository = jpaRepository;
        this.entityManager = entityManager;
    }

    @Override
    public void save(UploadPart part) {
        entityManager.merge(UploadPartEntity.from(part));
    }

    @Override
    public Optional<UploadPart> find(UUID uploadId, int partNo) {
        return jpaRepository.findById(new UploadPartId(uploadId, partNo))
                .map(UploadPartEntity::toDomain);
    }

    @Override
    public List<UploadPart> findByUploadId(UUID uploadId) {
        return jpaRepository.findByUploadId(uploadId).stream()
                .map(UploadPartEntity::toDomain).toList();
    }

    @Override
    public void deleteByUploadId(UUID uploadId) {
        jpaRepository.deleteByUploadId(uploadId);
    }

    @Override
    public UploadPart insertIfAbsent(UploadPart part) {
        entityManager.createNativeQuery("""
                        INSERT INTO file.upload_parts
                               (upload_id, workspace_id, part_no, sha256, size_bytes, etag,
                                created_at)
                        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                        ON CONFLICT (upload_id, part_no) DO NOTHING
                        """)
                .setParameter(1, part.uploadId())
                .setParameter(2, part.workspaceId())
                .setParameter(3, part.partNo())
                .setParameter(4, part.sha256().value())
                .setParameter(5, part.sizeBytes())
                .setParameter(6, part.etag())
                .setParameter(7, part.createdAt())
                .executeUpdate();
        return jpaRepository.findById(new UploadPartId(part.uploadId(), part.partNo()))
                .map(UploadPartEntity::toDomain)
                .orElseThrow(() -> new IllegalStateException("upload part insert failed"));
    }

    @Override
    public boolean existsWithDifferentHash(UUID uploadId, int partNo, Sha256 sha256) {
        return jpaRepository.findById(new UploadPartId(uploadId, partNo))
                .filter(entity -> !entity.getSha256().equals(sha256.value()))
                .isPresent();
    }
}
