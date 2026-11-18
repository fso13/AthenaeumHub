package ru.krug.backend.file.infrastructure.persistence;

import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import jakarta.persistence.EntityManager;

import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Repository;

import ru.krug.backend.file.domain.model.Attachment;
import ru.krug.backend.file.domain.repository.AttachmentRepository;

@Repository
public class AttachmentRepositoryAdapter implements AttachmentRepository {

    private final AttachmentJpaRepository jpaRepository;
    private final EntityManager entityManager;

    public AttachmentRepositoryAdapter(AttachmentJpaRepository jpaRepository,
                                       EntityManager entityManager) {
        this.jpaRepository = jpaRepository;
        this.entityManager = entityManager;
    }

    @Override
    public void save(Attachment attachment) {
        entityManager.merge(AttachmentEntity.from(attachment));
    }

    @Override
    public Optional<Attachment> findById(UUID workspaceId, UUID attachmentId) {
        return jpaRepository.findByIdAndWorkspaceId(attachmentId, workspaceId)
                .map(AttachmentEntity::toDomain);
    }

    @Override
    public Optional<Attachment> findForUpdate(UUID workspaceId, UUID attachmentId) {
        return jpaRepository.findForUpdate(attachmentId, workspaceId)
                .map(AttachmentEntity::toDomain);
    }

    @Override
    public Optional<Attachment> findForUpdateById(UUID attachmentId) {
        return jpaRepository.findForUpdateById(attachmentId).map(AttachmentEntity::toDomain);
    }

    @Override
    public Optional<Attachment> findByUploadId(UUID uploadId) {
        return jpaRepository.findByUploadId(uploadId).map(AttachmentEntity::toDomain);
    }

    @Override
    public List<Attachment> findByMessageIds(UUID workspaceId, Collection<UUID> messageIds) {
        if (messageIds == null || messageIds.isEmpty()) {
            return List.of();
        }
        return jpaRepository.findByWorkspaceIdAndMessageIdIn(workspaceId, messageIds).stream()
                .map(AttachmentEntity::toDomain).toList();
    }

    @Override
    public List<Attachment> findUnboundReadyBefore(Instant cutoff, int limit) {
        return jpaRepository.findUnboundReadyBefore(cutoff, PageRequest.of(0, limit)).stream()
                .map(AttachmentEntity::toDomain).toList();
    }

    @Override
    public Optional<Attachment> findByIdForResolve(UUID attachmentId) {
        return jpaRepository.findById(attachmentId).map(AttachmentEntity::toDomain);
    }
}
