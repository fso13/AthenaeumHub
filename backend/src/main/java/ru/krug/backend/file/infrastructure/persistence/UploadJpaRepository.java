package ru.krug.backend.file.infrastructure.persistence;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import jakarta.persistence.LockModeType;

import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface UploadJpaRepository extends JpaRepository<UploadEntity, UUID> {

    Optional<UploadEntity> findByIdAndWorkspaceId(UUID id, UUID workspaceId);

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select u from UploadEntity u where u.id = :id and u.workspaceId = :workspaceId")
    Optional<UploadEntity> findForUpdate(@Param("id") UUID id,
                                         @Param("workspaceId") UUID workspaceId);

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select u from UploadEntity u where u.id = :id")
    Optional<UploadEntity> findForUpdateById(@Param("id") UUID id);

    @Query("""
            select u from UploadEntity u
             where u.status in ('INIT', 'UPLOADING', 'PAUSED', 'SCANNING', 'READY')
               and u.expiresAt < :now
             order by u.expiresAt asc
            """)
    List<UploadEntity> findExpired(@Param("now") Instant now, Pageable pageable);

    @Query("""
            select u from UploadEntity u
             where u.status = 'SCANNING'
             order by u.updatedAt asc
            """)
    List<UploadEntity> findScanning(Pageable pageable);

    @Query("""
            select u from UploadEntity u
             where u.status = 'READY' and u.expiresAt < :cutoff
             order by u.expiresAt asc
            """)
    List<UploadEntity> findUnboundReadyBefore(@Param("cutoff") Instant cutoff, Pageable pageable);
}
