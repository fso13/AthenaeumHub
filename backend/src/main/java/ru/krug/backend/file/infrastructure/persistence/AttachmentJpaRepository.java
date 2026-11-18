package ru.krug.backend.file.infrastructure.persistence;

import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import jakarta.persistence.LockModeType;

import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface AttachmentJpaRepository extends JpaRepository<AttachmentEntity, UUID> {

    Optional<AttachmentEntity> findByIdAndWorkspaceId(UUID id, UUID workspaceId);

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select a from AttachmentEntity a where a.id = :id and a.workspaceId = :workspaceId")
    Optional<AttachmentEntity> findForUpdate(@Param("id") UUID id,
                                             @Param("workspaceId") UUID workspaceId);

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select a from AttachmentEntity a where a.id = :id")
    Optional<AttachmentEntity> findForUpdateById(@Param("id") UUID id);

    Optional<AttachmentEntity> findByUploadId(UUID uploadId);

    List<AttachmentEntity> findByWorkspaceIdAndMessageIdIn(UUID workspaceId,
                                                            Collection<UUID> messageIds);

    @Query("""
            select a from AttachmentEntity a
             where a.status = 'READY' and a.messageId is null and a.createdAt < :cutoff
             order by a.createdAt asc
            """)
    List<AttachmentEntity> findUnboundReadyBefore(@Param("cutoff") Instant cutoff,
                                                  Pageable pageable);
}
