package ru.krug.backend.ops.infrastructure.persistence;

import org.springframework.data.jpa.repository.JpaRepository;

public interface OutboxJpaRepository extends JpaRepository<OutboxEntity, Long> {
}
