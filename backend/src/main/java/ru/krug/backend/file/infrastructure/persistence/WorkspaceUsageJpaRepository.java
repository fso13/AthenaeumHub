package ru.krug.backend.file.infrastructure.persistence;

import java.util.Optional;
import java.util.UUID;

import jakarta.persistence.LockModeType;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface WorkspaceUsageJpaRepository
        extends JpaRepository<WorkspaceUsageEntity, UUID> {

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select u from WorkspaceUsageEntity u where u.workspaceId = :workspaceId")
    Optional<WorkspaceUsageEntity> findForUpdate(@Param("workspaceId") UUID workspaceId);
}
