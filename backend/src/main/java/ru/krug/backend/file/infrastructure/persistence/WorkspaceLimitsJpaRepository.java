package ru.krug.backend.file.infrastructure.persistence;

import java.util.UUID;

import org.springframework.data.jpa.repository.JpaRepository;

public interface WorkspaceLimitsJpaRepository
        extends JpaRepository<WorkspaceLimitsEntity, UUID> {
}
